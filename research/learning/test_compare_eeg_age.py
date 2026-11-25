import copy
import json
import unittest
from pathlib import Path

import numpy as np

from compare_eeg_age import conformal_radius, run


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.frozen = json.loads(Path("temporal-results/brain-age-weights.json").read_text())
        rng = np.random.default_rng(98)
        self.data = {}
        for site, ages in {
            "dortmund": np.repeat([25., 35., 45., 55., 65.], 50),
            "oslo": np.repeat([25., 35., 45., 55., 65.], 10),
            "athens": np.repeat([58., 64., 69.], 8),
        }.items():
            x = rng.normal(size=(len(ages), 27))
            x[:, 0] += ages / 10
            x[:, 8] = np.nan
            self.data[site] = [(str(i), age, "", row) for i, (age, row) in enumerate(zip(ages, x))]

    def test_finite_aggregate_and_held_out_cohort_independence(self):
        result = run(self.data, self.frozen, require_reference_counts=False)
        json.dumps(result, allow_nan=False)
        changed = copy.deepcopy(self.data)
        changed["athens"] = [
            (pid, 60., sex, x * 100) for pid, _, sex, x in changed["athens"]
        ]
        rerun = run(changed, self.frozen, require_reference_counts=False)
        for key in ("dortmund_nested", "oslo"):
            self.assertEqual(result[key], rerun[key])
        self.assertEqual(result["athens"]["published_frozen"]["n"], 24)
        self.assertIn("two_central_derivations", result["athens"])
        self.assertIn("coverage_90", result["oslo"]["affine_ridge35"]["age_strata"]["60-69"])

    def test_duplicate_participant_fails(self):
        self.data["dortmund"].append(self.data["dortmund"][0])
        with self.assertRaisesRegex(ValueError, "repeated participants"):
            run(self.data, self.frozen, require_reference_counts=False)

    def test_incomplete_cohort_fails(self):
        with self.assertRaisesRegex(ValueError, "expected 490"):
            run(self.data, self.frozen)

    def test_conformal_finite_sample_rank(self):
        self.assertEqual(conformal_radius(np.arange(19), np.zeros(19)), 17)
        with self.assertRaises(ValueError):
            conformal_radius(np.arange(8), np.zeros(8))


if __name__ == "__main__":
    unittest.main()
