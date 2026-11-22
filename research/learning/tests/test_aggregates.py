"""Exact published aggregates and participant-isolation regressions.

These tests do not refit anything. They assert that the committed research
results still carry the published numbers, that the unit of inference is the
participant, and that no per-participant held-out score leaked into the
aggregate files.
"""

import json
from pathlib import Path
import unittest

LEARNING = Path(__file__).resolve().parents[1]
RESULTS = LEARNING / "results"


def load(name):
    return json.loads((RESULTS / name).read_text())


def assert_no_held_out_scores(test, value):
    if isinstance(value, dict):
        test.assertNotIn("held_out_scores", value)
        test.assertNotIn("figure_derived_participant_medians", value)
        for child in value.values():
            assert_no_held_out_scores(test, child)
    elif isinstance(value, list):
        for child in value:
            assert_no_held_out_scores(test, child)


class PublishedAggregatesTest(unittest.TestCase):
    def test_propofol_transfer_auroc_and_participant_counts(self):
        r = load("propofol-transfer-results.json")
        self.assertEqual(r["frontal"]["cambridge_to_oslo"]["AUROC"]["value"], 0.87)
        self.assertEqual(r["frontal"]["oslo_to_cambridge"]["AUROC"]["value"], 0.79)
        self.assertEqual(r["broader"]["cambridge_to_oslo"]["AUROC"]["value"], 1.0)
        self.assertAlmostEqual(
            r["broader"]["oslo_to_cambridge"]["AUROC"]["value"], 0.8825, places=4
        )
        for montage in ("frontal", "broader"):
            for direction in ("cambridge_to_oslo", "oslo_to_cambridge"):
                row = r[montage][direction]
                self.assertEqual(row["paired_participants"], 20)
                self.assertEqual(row["per_stage"]["baseline"]["participants"], 20)
                self.assertEqual(row["per_stage"]["sedated"]["participants"], 20)

    def test_behavioural_analysis_is_participant_level(self):
        r = load("propofol-transfer-results.json")
        for montage in ("frontal", "broader"):
            behaviour = r[montage]["correct_response_prediction"]
            self.assertEqual(behaviour["sessions"], 80)
            self.assertEqual(behaviour["participants"], 20)
            self.assertEqual(
                behaviour["metrics"]["patient_mean_MAE_gain_EEG_plus_stage_vs_stage"]["value"],
                -0.004985935869512748
                if montage == "frontal"
                else 0.6621064326116961,
            )

    def test_awake_blockade_one_of_six(self):
        r = load("awake-blockade-alpha-results.json")
        self.assertEqual(r["participants"], 6)
        for mode in r["grouped_leave_one_out"].values():
            for counts in mode.values():
                self.assertEqual(counts["awake_blockade_false_sedated"], 1)
                self.assertLessEqual(counts["awake_blockade_false_sedated"], 6)
        self.assertEqual(
            r["grouped_leave_one_out"]["absolute"]["with_awake_blockade"][
                "propofol_protocol_detected"
            ],
            5,
        )
        self.assertEqual(
            r["grouped_leave_one_out"]["change_from_own_awake_baseline"][
                "with_awake_blockade"
            ]["propofol_protocol_detected"],
            6,
        )

    def test_blockade_challenge_aggregates(self):
        r = load("blockade-challenge-results.json")["heldout_protocol"]
        self.assertEqual(r["frontal"]["cambridge_to_oslo"]["auroc"], 0.8175)
        self.assertEqual(r["frontal"]["oslo_to_cambridge"]["auroc"], 0.8)
        self.assertEqual(r["broader"]["cambridge_to_oslo"]["auroc"], 1.0)
        self.assertEqual(r["broader"]["oslo_to_cambridge"]["auroc"], 0.895)
        for montage in ("frontal", "broader"):
            for direction in ("cambridge_to_oslo", "oslo_to_cambridge"):
                self.assertEqual(r[montage][direction]["pairs"], 20)

    def test_eye_control_is_separate_and_participant_level(self):
        r = load("propofol-eye-control.json")
        for montage in ("frontal", "broader"):
            row = r[montage]
            self.assertEqual(row["participants"], 20)
            self.assertEqual(row["above_half_while_awake_EC"], 3 if montage == "frontal" else 2)
            self.assertEqual(row["above_half_while_awake_EO"], 2)
            self.assertEqual(row["above_half_pre_awakening"], 14 if montage == "frontal" else 20)
            self.assertEqual(len(row["median_score_EC_EO_sedated"]), 3)

    def test_rocuronium_surgical_counts(self):
        r = load("rocuronium-surgical-results.json")
        self.assertEqual(r["track_intersection"], 264)
        self.assertEqual(r["timed_pump_transitions"], 32)
        self.assertEqual(r["cases"], 17)
        self.assertEqual(r["valid_windows"], 476)
        self.assertEqual(r["retention"]["no_confirming_pump_volume"], 14)
        self.assertEqual(r["retention"]["insufficient_clean_EEG"], 1)

    def test_neonatal_cohort_is_whole_baby(self):
        r = load("neonatal-results.json")
        self.assertEqual(r["cohort"]["neonates"], 79)
        self.assertEqual(r["cohort"]["outer_folds"], 5)
        self.assertEqual(r["cohort"]["patients_with_majority_events_10s"], 46)

    def test_no_held_out_participant_scores_are_published(self):
        for path in RESULTS.glob("*.json"):
            assert_no_held_out_scores(self, load(path.name))


if __name__ == "__main__":
    unittest.main()
