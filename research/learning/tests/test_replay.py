"""Executable regressions for the descriptor-only research replay policy.

Run from the repository root:
    python -m unittest discover -s research/learning/tests -v
"""

from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import io
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
    main,
    normalize_context,
    score,
)

RESULTS = LEARNING / "results"
ACQUIRED = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)
RECORDED = (ACQUIRED - timedelta(hours=2)).isoformat()


def raw_intervals(montage="frontal"):
    return [
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
    ]


def context(montage="frontal", **overrides):
    payload = {
        "blockade": "reported-absent",
        "case_id": "case-1",
        "acquired_at": ACQUIRED.isoformat(),
        "max_context_age_hours": 24,
        "intervals": raw_intervals(montage),
    }
    payload.update(overrides)
    return normalize_context(payload)


def write_session(
    path,
    hz=125,
    segments=10,
    derivations=("FP1-F7", "FP2-F8"),
    seconds=8,
    case_id="case-1",
    blockade=None,
    offsets=True,
    perturbation_hz=None,
):
    time = np.arange(hz * seconds) / hz
    waves = []
    for _ in range(segments):
        channels = [
            20 * np.sin(2 * np.pi * (8 + 0.4 * i) * time) + 6 * np.sin(2 * np.pi * 2 * time)
            for i in range(len(derivations))
        ]
        if perturbation_hz is not None:
            channels = [
                channel + 4 * np.sin(2 * np.pi * perturbation_hz * time) for channel in channels
            ]
        waves.append(channels)
    extra = {}
    if case_id is not None:
        extra["case_id"] = case_id
    if blockade is not None:
        extra["blockade_context"] = blockade
    if offsets:
        extra["segment_offsets"] = [i * seconds for i in range(segments)]
    np.savez(
        path,
        unit="uV",
        hz=hz,
        derivations=list(derivations),
        waveforms=np.asarray(waves, dtype="float64"),
        **extra,
    )


class ReplayPolicyTest(unittest.TestCase):
    def setUp(self):
        self.td = TemporaryDirectory()
        self.root = Path(self.td.name)
        self.file = self.root / "signal.npz"
        write_session(self.file)

    def tearDown(self):
        self.td.cleanup()

    def assert_non_scoring(self, out, status=None):
        if status is not None:
            self.assertEqual(out["status"], status, out["reason"])
        else:
            self.assertNotEqual(out["status"], SCORE_STATUS)
        self.assertIsNone(out[SCORE_NAME])
        self.assertIsNone(out["consciousness_inference"])
        for key in ("status", "context", "blockade_context", "reason", "coverage", "descriptors"):
            self.assertIn(key, out)

    def test_default_is_descriptor_only_and_never_scores(self):
        out = score("propofol", "frontal", self.file, RESULTS)
        self.assert_non_scoring(out, DESCRIPTOR_STATUS)
        self.assertEqual(out["coverage"]["usable_windows"], 10)
        self.assertIsNotNone(out["descriptors"])

    def test_unknown_and_omitted_context_abstain(self):
        out = score("propofol", "frontal", self.file, RESULTS, "unknown")
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("not independently documented", out["reason"])

    def test_documented_and_suspected_abstain_before_weights(self):
        missing = self.root / "no-such-model-dir"
        for blockade in ("documented", "suspected"):
            out = score("propofol", "frontal", self.file, missing, blockade)
            self.assert_non_scoring(out, DESCRIPTOR_STATUS)
            self.assertIn("withheld", out["reason"])

    def test_reported_absence_without_opt_in_stays_descriptor_only(self):
        out = score(
            "propofol", "frontal", self.file, RESULTS, context=context(), allow_research_score=False
        )
        self.assert_non_scoring(out, DESCRIPTOR_STATUS)
        self.assertIn("opt-in", out["reason"])

    def test_genuine_positive_control_scores_with_provenance(self):
        out = score(
            "propofol", "frontal", self.file, RESULTS, context=context(), allow_research_score=True
        )
        self.assertEqual(out["status"], SCORE_STATUS, out["reason"])
        self.assertIsInstance(out[SCORE_NAME], float)
        self.assertTrue(0.0 <= out[SCORE_NAME] <= 1.0)
        self.assertIsNone(out["consciousness_inference"])
        self.assertEqual(out["blockade_context"], "reported-absent")
        self.assertEqual(out["context"]["case_id"], "case-1")
        self.assertEqual(out["coverage"]["usable_windows"], 10)
        self.assertTrue(out["model"]["research_only"])
        self.assertFalse(out["model"]["clinical_depth"])
        self.assertEqual(out["model"]["version"], 1)

    def _context_file(self):
        path = self.root / "context.json"
        path.write_text(
            json.dumps(
                {
                    "blockade": "reported-absent",
                    "case_id": "case-1",
                    "acquired_at": ACQUIRED.isoformat(),
                    "max_context_age_hours": 24,
                    "intervals": raw_intervals(),
                }
            )
        )
        return path

    def _run_cli(self, *extra):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            main(
                [
                    "propofol",
                    "frontal",
                    str(self.file),
                    "--models",
                    str(RESULTS),
                    "--context",
                    str(self._context_file()),
                    *extra,
                ]
            )
        return json.loads(buffer.getvalue())

    def test_cli_eligible_control_scores_with_the_explicit_opt_in(self):
        out = self._run_cli("--allow-research-score")
        self.assertEqual(out["status"], SCORE_STATUS, out["reason"])
        self.assertIsInstance(out[SCORE_NAME], float)
        self.assertTrue(0.0 <= out[SCORE_NAME] <= 1.0)
        self.assertIsNone(out["consciousness_inference"])
        self.assertEqual(out["blockade_context"], "reported-absent")

    def test_cli_eligible_control_without_the_opt_in_stays_descriptor_only(self):
        out = self._run_cli()
        self.assert_non_scoring(out, DESCRIPTOR_STATUS)
        self.assertIn("opt-in", out["reason"])

    def test_elapsed_35hz_masking_does_not_move_descriptors_or_the_score(self):
        masked = self.root / "masked.npz"
        write_session(masked, perturbation_hz=35)
        clean = score(
            "propofol", "frontal", self.file, RESULTS, context=context(), allow_research_score=True
        )
        noisy = score(
            "propofol", "frontal", masked, RESULTS, context=context(), allow_research_score=True
        )
        self.assertEqual(clean["status"], SCORE_STATUS)
        self.assertEqual(noisy["status"], SCORE_STATUS)
        self.assertAlmostEqual(
            clean["descriptors"]["EEG_log_theta_to_delta"],
            noisy["descriptors"]["EEG_log_theta_to_delta"],
            places=3,
        )
        self.assertAlmostEqual(
            clean["descriptors"]["EEG_log_alpha_to_delta"],
            noisy["descriptors"]["EEG_log_alpha_to_delta"],
            places=3,
        )
        # The protocol score itself may move under a high-frequency mask; it
        # stays a research descriptor and never becomes a clinical depth.
        self.assertTrue(noisy["model"]["research_only"])
        self.assertFalse(noisy["model"]["clinical_depth"])

    def test_reported_defect_identity_reference_and_coverage_abstains(self):
        """80 s recording labelled 'other'/'documented', sidecar 0–1 s/'arbitrary'."""
        path = self.root / "other.npz"
        write_session(path, case_id="other", blockade="documented")
        sidecar = normalize_context(
            {
                "blockade": "reported-absent",
                "case_id": "case-1",
                "acquired_at": ACQUIRED.isoformat(),
                "intervals": [
                    {
                        "start": 0,
                        "end": 1,
                        "absence_documented": True,
                        "source": "note",
                        "recorded_at": RECORDED,
                        "montage": "frontal",
                        "reference": "arbitrary",
                        "calibration": "uV",
                    }
                ],
            }
        )
        out = score(
            "propofol", "frontal", path, RESULTS, context=sidecar, allow_research_score=True
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertNotAlmostEqual(out[SCORE_NAME] or 0.0, 0.9006865, places=6)
        self.assertIn("blockade", out["reason"])

    def test_embedded_documented_metadata_beats_an_absent_sidecar(self):
        path = self.root / "embedded.npz"
        write_session(path, blockade="documented")
        out = score(
            "propofol", "frontal", path, RESULTS, context=context(), allow_research_score=True
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("withheld", out["reason"])

    def test_missing_embedded_case_identity_abstains(self):
        path = self.root / "anonymous.npz"
        write_session(path, case_id=None)
        out = score(
            "propofol", "frontal", path, RESULTS, context=context(), allow_research_score=True
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("case identity", out["reason"])

    def test_case_identity_mismatch_abstains(self):
        path = self.root / "other-case.npz"
        write_session(path, case_id="other")
        out = score(
            "propofol", "frontal", path, RESULTS, context=context(), allow_research_score=True
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("does not match", out["reason"])

    def test_missing_acquisition_time_never_falls_back_to_wall_clock(self):
        no_time = normalize_context(
            {
                "blockade": "reported-absent",
                "case_id": "case-1",
                "intervals": raw_intervals(),
            }
        )
        out = score(
            "propofol",
            "frontal",
            self.file,
            RESULTS,
            context=no_time,
            allow_research_score=True,
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("acquisition time", out["reason"])

    def test_arbitrary_reference_abstains(self):
        arbitrary = context()
        arbitrary["intervals"][0]["reference"] = "arbitrary"
        out = score(
            "propofol", "frontal", self.file, RESULTS, context=arbitrary, allow_research_score=True
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("reference", out["reason"])

    def test_partial_interval_coverage_abstains(self):
        partial = context()
        partial["intervals"][0]["end"] = 1
        out = score(
            "propofol", "frontal", self.file, RESULTS, context=partial, allow_research_score=True
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("end of the recording", out["reason"])

    def test_multiple_segments_without_offsets_abstain(self):
        path = self.root / "no-offsets.npz"
        write_session(path, offsets=False)
        out = score(
            "propofol", "frontal", path, RESULTS, context=context(), allow_research_score=True
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("offsets", out["reason"])

    def test_segment_outside_documented_interval_abstains(self):
        path = self.root / "shifted.npz"
        write_session(path, offsets=False)
        with np.load(path) as data:
            payload = {key: data[key] for key in data.files}
        payload["segment_offsets"] = [i * 8 for i in range(10)]
        np.savez(path, **payload)
        shifted = context()
        shifted["intervals"][0]["start"] = 8
        out = score(
            "propofol", "frontal", path, RESULTS, context=shifted, allow_research_score=True
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("start of the recording", out["reason"])

    def test_descriptors_survive_clean_coverage_below_the_score_threshold(self):
        path = self.root / "short.npz"
        write_session(path, segments=4)
        short = context()
        short["intervals"][0]["end"] = 32
        out = score(
            "propofol", "frontal", path, RESULTS, context=short, allow_research_score=True
        )
        self.assert_non_scoring(out, INSUFFICIENT_STATUS)
        self.assertIn("sparse", out["reason"])
        self.assertIsNotNone(out["descriptors"])

    def test_missing_weights_do_not_break_abstention(self):
        missing = self.root / "no-such-model-dir"
        out = score(
            "propofol", "frontal", self.file, missing, context=context(), allow_research_score=False
        )
        self.assert_non_scoring(out, DESCRIPTOR_STATUS)

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
            self.assertEqual(out["status"], SCORE_STATUS, out["reason"])
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
            case_id="case-1",
            segment_offsets=[i * 8 for i in range(100)],
        )
        long = context()
        long["intervals"][0]["end"] = 800
        out = score(
            "propofol", "frontal", path, RESULTS, context=long, allow_research_score=True
        )
        self.assert_non_scoring(out, INSUFFICIENT_STATUS)
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
            case_id="case-1",
            segment_offsets=[i * 8 for i in range(10)],
        )
        out = score("propofol", "frontal", flat, RESULTS, "documented")
        self.assert_non_scoring(out, INSUFFICIENT_STATUS)

        partial = self.root / "partial.npz"
        write_session(partial, seconds=8)
        with np.load(partial) as data:
            unit, hz = data["unit"], data["hz"]
            derivations = data["derivations"]
            waves = data["waveforms"][:, :, : 125 * 4]
        np.savez(
            partial,
            unit=unit,
            hz=hz,
            derivations=derivations,
            waveforms=waves,
            case_id="case-1",
            segment_offsets=[i * 8 for i in range(10)],
        )
        out = score("propofol", "frontal", partial, RESULTS, "documented")
        self.assert_non_scoring(out, INSUFFICIENT_STATUS)
        self.assertIn("partial", out["reason"])

    def test_cli_and_file_conflict_is_structured_not_a_crash(self):
        out = score(
            "propofol",
            "frontal",
            self.file,
            RESULTS,
            "documented",
            context=context(),
        )
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("conflicts", out["reason"])
        self.assertEqual(out["context"]["blockade"], "documented")

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

    def test_unknown_keys_and_non_boolean_safety_flags_are_rejected(self):
        with self.assertRaises(ContextError):
            normalize_context({"blockade": "reported-absent", "intervls": []})
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
                            "calibration": "uV",
                            "gap_before": "yes",
                        }
                    ],
                }
            )

    def test_caller_increased_evidence_lifetime_is_rejected(self):
        with self.assertRaises(ContextError):
            normalize_context(
                {
                    "blockade": "reported-absent",
                    "case_id": "case-1",
                    "acquired_at": ACQUIRED.isoformat(),
                    "max_context_age_hours": 240,
                    "intervals": [],
                }
            )

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
                "case_id": "case-1",
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
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("stale", out["reason"])

    def test_no_carryover_across_gap_bolus_reversal_or_case_change(self):
        for flag in ("gap_before", "bolus_within_interval", "reversal_uncertain", "case_changed"):
            intervals = raw_intervals()
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
            self.assert_non_scoring(out, ABSTAINED_STATUS)
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
                "case_id": "case-1",
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
        self.assert_non_scoring(out, ABSTAINED_STATUS)
        self.assertIn("not contiguous", out["reason"])

    def test_status_context_reason_and_coverage_are_always_present(self):
        out = score("propofol", "frontal", self.file, RESULTS, "unknown")
        for key in ("status", "context", "blockade_context", "reason", "coverage", "consciousness_inference"):
            self.assertIn(key, out)
        self.assertIsNone(out["consciousness_inference"])
        self.assertIsNone(out[SCORE_NAME])
        self.assertEqual(
            set(out["context"]), {"blockade", "case_id", "acquired_at"}
        )


if __name__ == "__main__":
    unittest.main()
