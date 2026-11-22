"""Executable regressions for the descriptor-only research replay policy.

Run from the repository root:
    python -m unittest discover -s research/learning/tests -v
"""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

import numpy as np

LEARNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LEARNING))

from replay import (  # noqa: E402
    ABSTAINED_STATUS,
    DESCRIPTOR_STATUS,
    INSUFFICIENT_STATUS,
    SCORE_NAME,
    SCORE_STATUS,
    ContextError,
    normalize_context,
    score,
)

RESULTS = LEARNING / "results"
ACQUIRED = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)
RECORDED = (ACQUIRED - timedelta(hours=2)).isoformat()


def context(montage="frontal", **overrides):
    payload = {
        "blockade": "reported-absent",
        "case_id": "case-1",
        "acquired_at": ACQUIRED.isoformat(),
        "max_context_age_hours": 24,
        "intervals": [
            {
                "start": 0,
                "end": 80,
                "absence_documented": True,
                "source": "independent neuromuscular monitor record",
                "recorded_at": RECORDED,
                "montage": montage,
                "reference": "mastoid",
                "calibration": "uV",
            }
        ],
    }
    payload.update(overrides)
    return normalize_context(payload)


def write_session(path, hz=125, segments=10, derivations=("FP1-F7", "FP2-F8"), seconds=8):
    time = np.arange(hz * seconds) / hz
    waves = []
    for _ in range(segments):
        channels = [
            20 * np.sin(2 * np.pi * (8 + 0.4 * i) * time) + 6 * np.sin(2 * np.pi * 2 * time)
            for i in range(len(derivations))
        ]
        waves.append(channels)
    np.savez(
        path,
        unit="uV",
        hz=hz,
        derivations=list(derivations),
        waveforms=np.asarray(waves, dtype="float64"),
    )


class ReplayPolicyTest(unittest.TestCase):
    def setUp(self):
        self.td = TemporaryDirectory()
        self.root = Path(self.td.name)
        self.file = self.root / "signal.npz"
        write_session(self.file)

    def tearDown(self):
        self.td.cleanup()

    def test_default_is_descriptor_only_and_never_scores(self):
        out = score("propofol", "frontal", self.file, RESULTS)
        self.assertEqual(out["status"], DESCRIPTOR_STATUS)
        self.assertIsNone(out["consciousness_inference"])
        self.assertIsNone(out[SCORE_NAME])
        self.assertEqual(out["coverage"]["usable_windows"], 10)

    def test_unknown_and_omitted_context_abstain(self):
        for blockade in ("unknown",):
            out = score("propofol", "frontal", self.file, RESULTS, blockade)
            self.assertEqual(out["status"], ABSTAINED_STATUS)
            self.assertIsNone(out[SCORE_NAME])
        out = score("propofol", "frontal", self.file, RESULTS, "unknown")
        self.assertIn("not independently documented", out["reason"])

    def test_documented_and_suspected_abstain_before_weights(self):
        missing = self.root / "no-such-model-dir"
        for blockade in ("documented", "suspected"):
            out = score("propofol", "frontal", self.file, missing, blockade)
            self.assertEqual(out["status"], DESCRIPTOR_STATUS)
            self.assertIsNone(out[SCORE_NAME])
            self.assertIn("withheld", out["reason"])

    def test_reported_absence_without_opt_in_stays_descriptor_only(self):
        out = score(
            "propofol", "frontal", self.file, RESULTS, context=context(), allow_research_score=False
        )
        self.assertEqual(out["status"], DESCRIPTOR_STATUS)
        self.assertIsNone(out[SCORE_NAME])
        self.assertIn("opt-in", out["reason"])

    def test_reported_absence_with_opt_in_scores_only_the_named_field(self):
        out = score(
            "propofol", "frontal", self.file, RESULTS, context=context(), allow_research_score=True
        )
        self.assertEqual(out["status"], SCORE_STATUS)
        self.assertIsInstance(out[SCORE_NAME], float)
        self.assertTrue(0.0 <= out[SCORE_NAME] <= 1.0)
        self.assertIsNone(out["consciousness_inference"])
        self.assertEqual(out["blockade_context"], "reported-absent")
        self.assertEqual(out["coverage"]["usable_windows"], 10)

    def test_missing_weights_do_not_break_abstention(self):
        missing = self.root / "no-such-model-dir"
        out = score(
            "propofol", "frontal", self.file, missing, context=context(), allow_research_score=False
        )
        self.assertEqual(out["status"], DESCRIPTOR_STATUS)
        self.assertIsNone(out[SCORE_NAME])

    def test_missing_weights_raise_when_a_score_is_requested(self):
        missing = self.root / "no-such-model-dir"
        with self.assertRaises(ValueError):
            score(
                "propofol",
                "frontal",
                self.file,
                missing,
                context=context(),
                allow_research_score=True,
            )

    def test_both_montages(self):
        broad = self.root / "broad.npz"
        write_session(
            broad,
            derivations=("FP1-F7", "FP2-F8", "F3-C3", "F4-C4", "P3-O1", "P4-O2"),
        )
        for montage, path in (("frontal", self.file), ("broader", broad)):
            out = score(
                "propofol",
                montage,
                path,
                RESULTS,
                context=context(montage),
                allow_research_score=True,
            )
            self.assertEqual(out["status"], SCORE_STATUS, montage)
            self.assertIsInstance(out[SCORE_NAME], float)

    def test_sparse_coverage_is_suppressed(self):
        path = self.root / "sparse.npz"
        time = np.arange(125 * 8) / 125
        good = np.stack([20 * np.sin(2 * np.pi * 8 * time), 14 * np.sin(2 * np.pi * 9 * time)])
        waves = [np.zeros_like(good) for _ in range(98)] + [good, good]
        np.savez(
            path,
            unit="uV",
            hz=125,
            derivations=["FP1-F7", "FP2-F8"],
            waveforms=np.asarray(waves),
        )
        out = score(
            "propofol", "frontal", path, RESULTS, context=context(), allow_research_score=True
        )
        self.assertEqual(out["status"], INSUFFICIENT_STATUS)
        self.assertIsNone(out[SCORE_NAME])
        self.assertEqual(out["coverage"]["usable_windows"], 2)
        self.assertEqual(out["coverage"]["total_windows"], 100)

    def test_qc_error_and_partial_segments_are_suppressed(self):
        flat = self.root / "flat.npz"
        np.savez(
            flat,
            unit="uV",
            hz=125,
            derivations=["FP1-F7", "FP2-F8"],
            waveforms=np.zeros((10, 2, 125 * 8)),
        )
        out = score("propofol", "frontal", flat, RESULTS, "documented")
        self.assertEqual(out["status"], INSUFFICIENT_STATUS)
        self.assertIsNone(out[SCORE_NAME])

        partial = self.root / "partial.npz"
        write_session(partial, seconds=8)
        with np.load(partial) as data:
            unit, hz = data["unit"], data["hz"]
            derivations = data["derivations"]
            waves = data["waveforms"][:, :, : 125 * 4]
        np.savez(partial, unit=unit, hz=hz, derivations=derivations, waveforms=waves)
        out = score("propofol", "frontal", partial, RESULTS, "documented")
        self.assertEqual(out["status"], INSUFFICIENT_STATUS)
        self.assertIn("partial", out["reason"])

    def test_cli_and_file_conflict_is_rejected(self):
        with self.assertRaises(ContextError):
            score(
                "propofol",
                "frontal",
                self.file,
                RESULTS,
                "documented",
                context=context(),
            )

    def test_invalid_context_values_are_rejected(self):
        with self.assertRaises(ContextError):
            normalize_context(
                {
                    "blockade": "reported-absent",
                    "intervals": [{"start": float("nan"), "end": 8, "absence_documented": True}],
                }
            )
        with self.assertRaises(ContextError):
            normalize_context({"blockade": "certainly-not-a-state"})

    def test_absence_without_provenance_is_rejected(self):
        with self.assertRaises(ContextError):
            normalize_context(
                {
                    "blockade": "reported-absent",
                    "intervals": [
                        {
                            "start": 0,
                            "end": 8,
                            "absence_documented": True,
                            "source": "monitor",
                            "recorded_at": RECORDED,
                            "montage": "frontal",
                            "reference": "mastoid",
                        }
                    ],
                }
            )

    def test_stale_evidence_abstains(self):
        stale = normalize_context(
            {
                "blockade": "reported-absent",
                "acquired_at": ACQUIRED.isoformat(),
                "max_context_age_hours": 1,
                "intervals": [
                    {
                        "start": 0,
                        "end": 80,
                        "absence_documented": True,
                        "source": "monitor",
                        "recorded_at": (ACQUIRED - timedelta(hours=3)).isoformat(),
                        "montage": "frontal",
                        "reference": "mastoid",
                        "calibration": "uV",
                    }
                ],
            }
        )
        out = score(
            "propofol",
            "frontal",
            self.file,
            RESULTS,
            context=stale,
            allow_research_score=True,
        )
        self.assertEqual(out["status"], ABSTAINED_STATUS)
        self.assertIn("stale", out["reason"])

    def test_no_carryover_across_gap_bolus_reversal_or_case_change(self):
        for flag in ("gap_before", "bolus_within_interval", "reversal_uncertain", "case_changed"):
            intervals = context()["intervals"]
            intervals[0][flag] = True
            ctx = {
                "blockade": "reported-absent",
                "case_id": "case-1",
                "acquired_at": ACQUIRED.isoformat(),
                "intervals": intervals,
            }
            out = score(
                "propofol",
                "frontal",
                self.file,
                RESULTS,
                context=normalize_context(ctx),
                allow_research_score=True,
            )
            self.assertEqual(out["status"], ABSTAINED_STATUS, flag)
            self.assertIsNone(out[SCORE_NAME])

    def test_mixed_segments_do_not_carry_evidence(self):
        def interval(start, end):
            return {
                "start": start,
                "end": end,
                "absence_documented": True,
                "source": "independent monitor record",
                "recorded_at": RECORDED,
                "montage": "frontal",
                "reference": "mastoid",
                "calibration": "uV",
            }

        mixed = normalize_context(
            {
                "blockade": "reported-absent",
                "acquired_at": ACQUIRED.isoformat(),
                "intervals": [interval(0, 40), interval(48, 80)],
            }
        )
        out = score(
            "propofol",
            "frontal",
            self.file,
            RESULTS,
            context=mixed,
            allow_research_score=True,
        )
        self.assertEqual(out["status"], ABSTAINED_STATUS)
        self.assertIn("not contiguous", out["reason"])

    def test_high_frequency_perturbation_does_not_move_low_band_ratios(self):
        perturbed = self.root / "perturbed.npz"
        with np.load(self.file) as data:
            unit, hz = data["unit"], data["hz"]
            derivations = data["derivations"]
            waves = data["waveforms"].copy()
        time = np.arange(waves.shape[2]) / float(hz)
        waves += 4 * np.sin(2 * np.pi * 35 * time)[None, None, :]
        np.savez(perturbed, unit=unit, hz=hz, derivations=derivations, waveforms=waves)
        a = score("propofol", "frontal", self.file, RESULTS, "documented")["descriptors"]
        b = score("propofol", "frontal", perturbed, RESULTS, "documented")["descriptors"]
        self.assertAlmostEqual(
            a["EEG_log_theta_to_delta"], b["EEG_log_theta_to_delta"], places=3
        )
        self.assertAlmostEqual(
            a["EEG_log_alpha_to_delta"], b["EEG_log_alpha_to_delta"], places=3
        )

    def test_status_context_reason_and_coverage_are_always_present(self):
        out = score("propofol", "frontal", self.file, RESULTS, "unknown")
        for key in ("status", "blockade_context", "reason", "coverage", "consciousness_inference"):
            self.assertIn(key, out)
        self.assertIsNone(out["consciousness_inference"])
        self.assertIsNone(out[SCORE_NAME])


if __name__ == "__main__":
    unittest.main()
