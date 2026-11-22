"""Small offline checks for the published comparison's fit and resampling rules.

These tests do not refit the published cohort and do not touch the network. They
pin the source PDF, assert the four published confusion-count tuples, and prove
the properties the reported numbers rely on: subject-disjoint fitting,
train-only scaling, a pre-block reference and case-disjoint VitalDB resampling.

Run from the repository root:
    python -m unittest discover -s research/learning/tests -v
"""

import hashlib
import json
from pathlib import Path
import sys
import unittest

import numpy as np

LEARNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LEARNING))

import awake_blockade_fit as blockade  # noqa: E402
import rocuronium_waveforms as surgical  # noqa: E402

RESULTS = LEARNING / "results"
PINNED_PDF = "a0a9131f04a66a89a0c5cbcee55ff40c3800abbc4f27ae3b6e6e34e0f67fc307"


def published():
    return json.loads((RESULTS / "awake-blockade-alpha-results.json").read_text())


class PinnedSourceTest(unittest.TestCase):
    def test_source_pdf_hash_is_pinned_before_the_fit(self):
        self.assertEqual(blockade.SOURCE_SHA256, PINNED_PDF)
        self.assertEqual(published()["source_sha256"], PINNED_PDF)

    def test_all_four_published_confusion_tuples(self):
        observed = {
            (mode, name): (
                counts["awake_pre_false_sedated"],
                counts["awake_blockade_false_sedated"],
                counts["propofol_protocol_detected"],
            )
            for mode, group in published()["grouped_leave_one_out"].items()
            for name, counts in group.items()
        }
        self.assertEqual(len(observed), 4)
        self.assertEqual(observed, blockade.PUBLISHED_CONFUSION)


class GroupedFitTest(unittest.TestCase):
    def test_each_participant_is_held_out_exactly_once(self):
        pairs = blockade.folds(6)
        self.assertEqual(sorted(held for _, held in pairs), list(range(6)))
        for train, held in pairs:
            self.assertNotIn(held, train.tolist())
            self.assertEqual(len(train), 5)

    def test_held_participant_is_absent_from_training_and_scaling(self):
        # Ten-unit spacing keeps every participant's values distinguishable.
        samples = np.array([[float(10 * p + k) for k in range(3)] for p in range(6)])
        calls = []
        original = blockade.fit

        def record(x, y):
            calls.append(np.asarray(x, dtype=float).copy())
            return original(x, y)

        blockade.fit = record
        try:
            blockade.grouped_leave_one_out(samples, [0, 1, 2])
        finally:
            blockade.fit = original
        self.assertEqual(len(calls), 6)
        for (_, held), seen in zip(blockade.folds(6), calls):
            self.assertFalse(set(samples[held].tolist()) & set(seen.tolist()), held)
            self.assertEqual(len(seen), 15)  # five training participants, three states

    def test_scaling_is_fitted_on_training_rows_only(self):
        train = np.array([0.0, 1.0, 2.0])
        spec = blockade.fit(train, np.array([0, 0, 1]))
        self.assertAlmostEqual(spec["mean"], train.mean())
        self.assertAlmostEqual(spec["scale"], train.std())
        # An excluded value would move the statistics if it entered the scaler.
        self.assertNotAlmostEqual(spec["mean"], np.append(train, 999.0).mean())


class PreBlockReferenceTest(unittest.TestCase):
    def test_change_model_uses_each_participants_own_pre_block_sample(self):
        x = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
        changed = blockade.change_from_baseline(x)
        self.assertTrue(np.allclose(changed[:, 0], 0.0))
        self.assertTrue(np.allclose(changed[0], [0.0, 1.0, 2.0]))
        self.assertTrue(np.allclose(changed[1], [0.0, 1.0, 2.0]))
        # A cohort-mean reference would not cancel each participant's own baseline.
        self.assertFalse(np.allclose((x - x.mean(axis=0))[:, 0], 0.0))

    def test_pre_block_baseline_cannot_discriminate_on_its_own(self):
        rng = np.random.default_rng(5)
        samples = blockade.change_from_baseline(rng.normal(size=(6, 3)))
        model = blockade.fit(
            samples[:, [0, 1, 2]].ravel(), np.tile([False, True, True], len(samples))
        )
        # Every participant's pre-block sample is the same zero change, so one
        # model gives it one score.
        baseline = blockade.predict(samples[:, 0], model)
        self.assertEqual(len(set(np.round(baseline, 12))), 1)


class VitalDbResamplingTest(unittest.TestCase):
    def test_case_folds_never_split_a_case(self):
        groups = np.array([1, 1, 1, 2, 2, 3, 3, 3, 3])
        folds = surgical.case_folds(groups)
        tested = []
        for train, test in folds:
            self.assertFalse(set(groups[train]) & set(groups[test]))
            tested.extend(groups[test].tolist())
        self.assertEqual(sorted(set(tested)), [1, 2, 3])
        for case in (1, 2, 3):
            self.assertEqual(sum(case in set(groups[test]) for _, test in folds), 1)

    def test_case_bootstrap_resamples_cases_not_windows(self):
        diff = np.array([0.1, 0.2, 0.9])
        lo, hi = surgical.case_bootstrap(diff, draws=2000, seed=684)
        rng = np.random.default_rng(684)
        expected = np.quantile(
            rng.choice(diff, (2000, len(diff)), replace=True).mean(axis=1), [0.025, 0.975]
        )
        self.assertTrue(np.allclose([lo, hi], expected))
        # Resampling the nine windows instead of the three cases narrows the interval.
        window_lo, window_hi = surgical.case_bootstrap(np.repeat(diff, 3), draws=2000, seed=684)
        self.assertLessEqual(lo, window_lo)
        self.assertGreaterEqual(hi, window_hi)

    def test_per_case_is_one_value_per_case(self):
        cases, values = surgical.per_case(
            np.array([1, 1, 1, 2, 2]), np.array([1.0, 1.0, 1.0, 10.0, 10.0])
        )
        self.assertEqual(cases.tolist(), [1, 2])
        self.assertTrue(np.allclose(values, [1.0, 10.0]))

    def test_assess_reports_one_observation_per_case(self):
        rng = np.random.default_rng(11)
        rows = [
            [case, -96 + 8 * window, 30 + 5 * rng.normal(), *rng.normal(size=7)]
            for case in (1, 2, 3)
            for window in range(4)
        ]
        metrics, model = surgical.assess(rows)
        self.assertEqual(metrics["cases"], 3)
        self.assertEqual(metrics["valid_windows"], 12)
        self.assertEqual(len(metrics["paired_MAE_gain_ci"]), 2)
        self.assertEqual(model["endpoint"], "device EMG in dB only")


class ProtocolDraftTest(unittest.TestCase):
    def setUp(self):
        self.protocol = LEARNING / "external-validation-protocol.md"
        self.lock = LEARNING / "external-validation-protocol.sha256"
        self.text = " ".join(self.protocol.read_text().lower().split())

    def test_draft_checksum_matches_the_versioned_text(self):
        digest = hashlib.sha256(self.protocol.read_bytes()).hexdigest()
        self.assertEqual(self.lock.read_text().split()[0], digest)

    def test_draft_is_unapproved_and_unregistered(self):
        for phrase in (
            "draft, version 2",
            "not approved",
            "not registered",
            "no independent statistical or clinical approval has been given",
            "no registration has occurred",
            "access to new outcomes is prohibited",
        ):
            self.assertIn(phrase, self.text, phrase)

    def test_primary_inference_is_exact_binomial_with_a_nonzero_zero_event_bound(self):
        for phrase in (
            "exact binomial",
            "clopper",
            "independent participants",
            "proportion among scored participants",
            "coverage and abstention for all",
            "upper bound is nonzero",
            "1 - 0.025^(1/n)",
            "participant-cluster",
        ):
            self.assertIn(phrase, self.text, phrase)

    def test_sealed_evaluator_is_distinct_from_the_ordinary_replay(self):
        for phrase in (
            "ordinary replay",
            "abstain on 100%",
            "sealed evaluator",
            "always-abstaining model has no discrimination estimate",
            "false episodes",
            "duration",
            "time affected",
        ):
            self.assertIn(phrase, self.text, phrase)

    def test_decision_parameters_are_frozen_before_outcome_access(self):
        for phrase in (
            "before any access to new outcomes",
            "episode persistence",
            "score threshold",
            "minimum usable coverage",
            "prospective sample size and precision targets",
            "illustrative",
            "no clinical-authorisation status",
            "prespecified acceptance criteria",
        ):
            self.assertIn(phrase, self.text, phrase)

    def test_arbitrary_error_cutoffs_and_zero_false_sedation_are_removed(self):
        self.assertNotIn("at most 10%", self.text)
        self.assertNotIn("at most 25%", self.text)
        self.assertNotIn(
            "no participant with a confirmed command response labelled sedated",
            self.text,
        )

    def test_original_one_in_six_result_is_kept(self):
        self.assertIn("1/6", self.text)
        self.assertIn("one of six", self.text)

    def test_required_protocol_terms_remain(self):
        for phrase in (
            "independent original voltages",
            "blinded",
            "command channel",
            "stable block",
            "95%",
            "coverage",
            "abstention",
            "no clinical release",
        ):
            self.assertIn(phrase, self.text, phrase)


if __name__ == "__main__":
    unittest.main()
