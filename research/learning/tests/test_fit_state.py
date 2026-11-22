"""Executable regressions for stage allowlisting in the between-centre fit.

Run from the repository root:
    python -m unittest discover -s research/learning/tests -v
"""

from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

import numpy as np

LEARNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LEARNING))

from fit_state import (  # noqa: E402
    OSLO_ACQUISITIONS,
    load,
    stage_of,
    summarize,
)


def write_cache(root, site, name, windows=3):
    folder = root / ("cache-" + site)
    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    x = rng.normal(size=(windows, 2, 13)).astype("float64")
    np.savez(folder / f"{name}.npz", x=x)


class StageAllowlistTest(unittest.TestCase):
    def test_cambridge_stages_are_allowlisted(self):
        for condition, expected in (
            ("1", "baseline"),
            ("2", "mild"),
            ("3", "sedated"),
            ("4", "recovery"),
            ("5", "unknown"),
            ("awake", "unknown"),
        ):
            self.assertEqual(stage_of("cambridge", condition), expected)

    def test_oslo_acquisitions_are_allowlisted(self):
        for condition, expected in (
            ("awake_acq-EC", "baseline"),
            ("awake_acq-EO", "eyes_open"),
            ("sedated", "sedated"),
            ("pre_awakening", "sedated"),
            ("pre-awakening", "sedated"),
            ("mystery_acq", "unknown"),
        ):
            self.assertEqual(stage_of("oslo", condition), expected)

    def test_unknown_oslo_file_never_becomes_sedated(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_cache(root, "oslo", "p1-awake_acq-EC")
            write_cache(root, "oslo", "p1-awake_acq-EO")
            write_cache(root, "oslo", "p1-sedated")
            write_cache(root, "oslo", "p1-mystery_acq")
            groups = load(root, "oslo")
        stages = {stage for _, stage in groups}
        self.assertEqual(stages, {"baseline", "eyes_open", "sedated", "unknown"})
        self.assertIn(("p1", "unknown"), groups)
        self.assertIn(("p1", "eyes_open"), groups)
        # Only the allowlisted sedated acquisition contributes to the sedated group.
        self.assertEqual(len(groups[("p1", "sedated")]["runs"]), 1)
        self.assertEqual(len(groups[("p1", "unknown")]["runs"]), 1)

    def test_unknown_cambridge_file_never_becomes_sedated(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            for condition in ("1", "2", "3", "4", "9"):
                write_cache(root, "cambridge", f"p1-{condition}")
            groups = load(root, "cambridge")
        self.assertIn(("p1", "unknown"), groups)
        self.assertEqual(
            {stage for _, stage in groups},
            {"baseline", "mild", "sedated", "recovery", "unknown"},
        )

    def test_summarize_excludes_unknown_acquisitions(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_cache(root, "oslo", "p1-awake_acq-EC")
            write_cache(root, "oslo", "p1-sedated")
            write_cache(root, "oslo", "p1-mystery_acq")
            groups = load(root, "oslo")
        rows = summarize(groups, "oslo", "frontal")
        self.assertEqual({row["state"] for row in rows}, {"baseline", "sedated"})
        self.assertTrue(all(row["pid"] == "p1" for row in rows))

    def test_eyes_open_control_is_not_a_sedated_stage(self):
        self.assertEqual(OSLO_ACQUISITIONS["awake_acq-EO"], "eyes_open")
        self.assertNotEqual(OSLO_ACQUISITIONS["awake_acq-EO"], "sedated")


if __name__ == "__main__":
    unittest.main()
