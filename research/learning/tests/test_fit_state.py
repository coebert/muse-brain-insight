"""Executable regressions for the pinned acquisition grammar and the state fitter.

Run from the repository root:
    python -m unittest discover -s research/learning/tests -v
"""

from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

import numpy as np

LEARNING = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LEARNING))

from acquisitions import (  # noqa: E402
    cache_name,
    manifest,
    parse_cache_name,
    parse_source_path,
)
from fit_state import load, load_report, stage_of, summarize  # noqa: E402
import provenance  # noqa: E402

EC = "sub-1010/eeg/sub-1010_task-awake_acq-EC_eeg.vhdr"
EO = "sub-1010/eeg/sub-1010_task-awake_acq-EO_eeg.vhdr"


def sed2(subject="1010", run=1):
    return f"sub-{subject}/eeg/sub-{subject}_task-sed2_acq-rest_run-{run}_eeg.vhdr"


def write_cache(root, site_name, name, windows=3, **meta):
    folder = root / ("cache-" + site_name)
    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    x = rng.normal(size=(windows, 2, 13)).astype("float64")
    np.savez(folder / f"{name}.npz", x=x, **meta)


def write_source(root, path, windows=3, **overrides):
    """Write an Oslo cache with the same provenance the extractor records."""
    entry = parse_source_path(path)
    meta = provenance.oslo_metadata(entry, path)
    meta.update(overrides)
    write_cache(root, "oslo", cache_name(entry), windows=windows, **meta)
    return entry


def write_cambridge(root, pid, level, correct=10, windows=3, **overrides):
    """Write a Cambridge cache with the same provenance the extractor records."""
    meta = provenance.cambridge_metadata(pid, level, f"Sedation-RestingState/{pid}{level}.set")
    meta.update(overrides)
    write_cache(root, "cambridge", f"{pid}-{level}", windows=windows, correct=correct, **meta)


class AcquisitionGrammarTest(unittest.TestCase):
    def test_real_extractor_names_map_to_protocol_stages(self):
        for condition, expected in (
            ("awake_acq-EC", "baseline"),
            ("awake_acq-EO", "eyes_open"),
            ("sed2_acq-rest_run-1", "sedated"),
            ("sed2_acq-rest_run-12", "sedated"),
            ("sedated", "unknown"),
            ("propofol", "unknown"),
            ("pre_awakening", "unknown"),
            ("awake_acq-EC_run-1", "unknown"),
        ):
            self.assertEqual(stage_of("oslo", condition), expected, condition)

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

    def test_extractor_to_fitter_round_trip_uses_actual_filenames(self):
        for path in (EC, EO, sed2(run=1), sed2(run=3)):
            entry = parse_source_path(path)
            self.assertIsNotNone(entry, path)
            parsed = parse_cache_name(cache_name(entry))
            self.assertIsNotNone(parsed, cache_name(entry))
            self.assertEqual(parsed["subject"], entry["subject"])
            self.assertEqual(parsed["condition"], entry["condition"])
            self.assertEqual(parsed["stage"], entry["stage"])

    def test_unrelated_protocol_arms_are_not_extracted(self):
        for path in (
            "sub-1010/eeg/sub-1010_task-sed_acq-rest_run-1_eeg.vhdr",
            "sub-1010/eeg/sub-1010_task-awake_acq-tms_eeg.vhdr",
            "sub-1010/eeg/sub-1010_task-sed2_acq-tms_run-1_eeg.vhdr",
            "sub-1010/eeg/sub-1010_task-sed2_acq-rest_eeg.vhdr",
        ):
            self.assertIsNone(parse_source_path(path), path)

    def test_manifest_matches_the_published_accounting(self):
        subjects = manifest()["subjects"]
        eligible = {key: row for key, row in subjects.items() if not row["excluded"]}
        self.assertEqual(len(eligible), 20)
        self.assertEqual(sum(1 for row in eligible.values() if row["awake_acq-EC"]), 20)
        self.assertEqual(sum(len(row["sed2_acq-rest"]) for row in eligible.values()), 51)
        self.assertEqual(20 + 51, 71)
        self.assertTrue(any(len(row["sed2_acq-rest"]) > 1 for row in eligible.values()))
        self.assertEqual([key for key, row in subjects.items() if row["excluded"]], ["1037"])


class FitterQuarantineTest(unittest.TestCase):
    def test_eyes_closed_baseline_and_each_sedated_run_form_an_eligible_pair(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, EC)
            for run in (1, 2, 3):
                write_source(root, sed2(run=run))
            groups, report = load_report(root, "oslo")
        self.assertEqual(report["quarantined"], [])
        self.assertEqual(len(report["accepted"]), 4)
        self.assertEqual(len(groups[("1010", "baseline")]["runs"]), 1)
        self.assertEqual(len(groups[("1010", "sedated")]["runs"]), 3)
        rows = summarize(groups, "oslo", "frontal")
        self.assertEqual({row["state"] for row in rows}, {"baseline", "sedated"})
        self.assertEqual(len(rows), 2)

    def test_eye_control_is_separate_and_never_a_baseline_or_sedated_sample(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, EC)
            write_source(root, EO)
            write_source(root, sed2(run=1))
            groups = load(root, "oslo")
        self.assertIn(("1010", "eyes_open"), groups)
        self.assertEqual(len(groups[("1010", "eyes_open")]["runs"]), 1)
        default_rows = summarize(groups, "oslo", "frontal")
        self.assertNotIn("eyes_open", {row["state"] for row in default_rows})
        with_control = summarize(
            groups, "oslo", "frontal", states=("baseline", "eyes_open", "sedated")
        )
        self.assertEqual(
            {row["state"] for row in with_control}, {"baseline", "eyes_open", "sedated"}
        )

    def test_unknown_names_are_quarantined_and_reported(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            for name in ("1010-propofol", "1010-sedated", "1010-awake_acq-EC_run-1", "1010"):
                write_cache(root, "oslo", name)
            groups, report = load_report(root, "oslo")
        self.assertEqual(groups, {})
        self.assertEqual(len(report["quarantined"]), 4)
        self.assertEqual(
            {row["reason"] for row in report["quarantined"]},
            {"unrecognised acquisition name"},
        )

    def test_contaminated_participant_label_is_quarantined(self):
        # The demonstrated risk: a cache named for participant 1010 carries
        # participant 1016's embedded identity. The filename must not win.
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, sed2(subject="1010", run=1), subject="1016")
            groups, report = load_report(root, "oslo")
        self.assertEqual(groups, {})
        self.assertEqual(len(report["quarantined"]), 1)
        reason = report["quarantined"][0]["reason"]
        self.assertIn("misfiled or renamed session", reason)
        self.assertIn("subject", reason)
        self.assertIn("1016", reason)
        self.assertIn("1010", reason)

    def test_two_allowed_subjects_stay_distinct(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, EC)
            write_source(root, sed2(subject="1010", run=1))
            write_source(root, "sub-1016/eeg/sub-1016_task-awake_acq-EC_eeg.vhdr")
            write_source(root, sed2(subject="1016", run=1))
            groups, report = load_report(root, "oslo")
        self.assertEqual(report["quarantined"], [])
        self.assertEqual(
            set(groups),
            {
                ("1010", "baseline"),
                ("1010", "sedated"),
                ("1016", "baseline"),
                ("1016", "sedated"),
            },
        )

    def test_contradictory_aliases_are_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, EC, task="sed2")
            write_source(root, sed2(run=1), condition="sed2_acq-rest_run-2")
            write_source(root, EO, acq="EC")
            groups, report = load_report(root, "oslo")
        self.assertEqual(groups, {})
        self.assertEqual(len(report["quarantined"]), 3)
        for row in report["quarantined"]:
            self.assertIn("misfiled or renamed session", row["reason"])

    def test_contradictory_source_path_is_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, sed2(subject="1010", run=1), source=sed2(subject="1016", run=1))
            groups, report = load_report(root, "oslo")
        self.assertEqual(groups, {})
        self.assertIn("source", report["quarantined"][0]["reason"])
        self.assertIn("1016", report["quarantined"][0]["reason"])

    def test_legitimate_multiple_runs_stay_paired(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, "sub-1016/eeg/sub-1016_task-awake_acq-EC_eeg.vhdr")
            for run in (1, 2):
                write_source(root, sed2(subject="1016", run=run))
            groups, report = load_report(root, "oslo")
        self.assertEqual(report["quarantined"], [])
        self.assertEqual(len(groups[("1016", "baseline")]["runs"]), 1)
        self.assertEqual(len(groups[("1016", "sedated")]["runs"]), 2)

    def test_renamed_copy_of_a_loaded_session_is_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            first = write_source(root, sed2(run=1))
            # A second file renamed to run 2 but still carrying run 1's identity.
            meta = provenance.oslo_metadata(first, sed2(run=1))
            write_cache(root, "oslo", cache_name(parse_source_path(sed2(run=2))), **meta)
            groups, report = load_report(root, "oslo")
        self.assertEqual(len(groups[("1010", "sedated")]["runs"]), 1)
        self.assertEqual(len(report["accepted"]), 1)
        self.assertIn("misfiled or renamed session", report["quarantined"][0]["reason"])

    def test_misfiled_session_is_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            run_one = parse_source_path(sed2(run=1))
            meta = provenance.oslo_metadata(run_one, sed2(run=1))
            write_cache(root, "oslo", cache_name(parse_source_path(sed2(run=2))), **meta)
            groups, report = load_report(root, "oslo")
        self.assertEqual(groups, {})
        self.assertEqual(len(report["quarantined"]), 1)
        self.assertIn("misfiled or renamed session", report["quarantined"][0]["reason"])

    def test_excluded_subject_and_unlisted_run_are_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, "sub-1037/eeg/sub-1037_task-awake_acq-EC_eeg.vhdr")
            write_source(root, sed2(run=9))
            groups, report = load_report(root, "oslo")
        self.assertEqual(groups, {})
        reasons = [row["reason"] for row in report["quarantined"]]
        self.assertTrue(any("excluded" in reason for reason in reasons), reasons)
        self.assertTrue(any("run 9" in reason for reason in reasons), reasons)

    def test_unattested_legacy_cache_is_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            entry = parse_source_path(sed2(run=1))
            write_cache(root, "oslo", cache_name(entry))
            groups, report = load_report(root, "oslo")
        self.assertEqual(groups, {})
        self.assertIn(provenance.LEGACY_REASON, report["quarantined"][0]["reason"])

    def test_extractor_attestation_rejects_legacy_and_accepts_provenance(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            entry = parse_source_path(sed2(run=1))
            write_cache(root, "oslo", cache_name(entry))
            path = root / "cache-oslo" / f"{cache_name(entry)}.npz"
            self.assertFalse(provenance.oslo_attested(path, entry))
            write_source(root, sed2(run=1))
            self.assertTrue(provenance.oslo_attested(path, entry))

    def test_checksum_pinned_mapping_can_attest_a_legacy_cache(self):
        record = {
            "site": "oslo",
            "subject": "1010",
            "task": "sed2",
            "acq": "rest",
            "run": 1,
            "condition": "sed2_acq-rest_run-1",
            "source": sed2(run=1),
        }
        with TemporaryDirectory() as td:
            root = Path(td)
            entry = parse_source_path(sed2(run=1))
            write_cache(root, "oslo", cache_name(entry))
            with mock.patch.object(provenance, "legacy_record", return_value=record):
                groups, report = load_report(root, "oslo")
        self.assertEqual(report["quarantined"], [])
        self.assertIn(("1010", "sedated"), groups)

    def test_checksum_pinned_mapping_cannot_override_a_contradiction(self):
        record = {
            "site": "oslo",
            "subject": "1016",
            "task": "sed2",
            "acq": "rest",
            "run": 1,
            "condition": "sed2_acq-rest_run-1",
            "source": sed2(subject="1016", run=1),
        }
        with TemporaryDirectory() as td:
            root = Path(td)
            entry = parse_source_path(sed2(run=1))
            write_cache(root, "oslo", cache_name(entry))
            with mock.patch.object(provenance, "legacy_record", return_value=record):
                groups, report = load_report(root, "oslo")
        self.assertEqual(groups, {})
        self.assertIn("checksum-pinned source mapping disagrees", report["quarantined"][0]["reason"])

    def test_checksum_pinned_mapping_requires_digest_and_site(self):
        record = {
            "site": "oslo",
            "subject": "1010",
            "task": "sed2",
            "acq": "rest",
            "run": 1,
            "condition": "sed2_acq-rest_run-1",
            "source": sed2(run=1),
        }
        mapping = {"sessions": {"deadbeef": record}}
        self.assertEqual(provenance.legacy_record("deadbeef", "oslo", mapping), record)
        self.assertIsNone(provenance.legacy_record("other", "oslo", mapping))
        self.assertIsNone(provenance.legacy_record("deadbeef", "cambridge", mapping))
        entry = parse_source_path(sed2(run=1))
        self.assertIsNone(
            provenance.oslo_record_problem(record, entry, origin="checksum-pinned")
        )

    def test_twenty_eligible_oslo_participants_are_recoverable(self):
        eligible = {key: row for key, row in manifest()["subjects"].items() if not row["excluded"]}
        self.assertEqual(len(eligible), 20)
        with TemporaryDirectory() as td:
            root = Path(td)
            for subject, row in eligible.items():
                write_source(root, f"sub-{subject}/eeg/sub-{subject}_task-awake_acq-EC_eeg.vhdr")
                write_source(root, sed2(subject=subject, run=row["sed2_acq-rest"][0]))
            groups, report = load_report(root, "oslo")
            rows = summarize(groups, "oslo", "frontal")
        self.assertEqual(report["quarantined"], [])
        self.assertEqual(len(report["accepted"]), 40)
        participants = {row["pid"] for row in rows}
        self.assertEqual(len(participants), 20)
        for pid in participants:
            states = {row["state"] for row in rows if row["pid"] == pid}
            self.assertEqual(states, {"baseline", "sedated"})

    def test_cambridge_unrecognised_stage_is_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_cache(root, "cambridge", "p1-9")
            write_cache(root, "cambridge", "p1")
            write_cambridge(root, "p1", "3", correct=10)
            groups, report = load_report(root, "cambridge")
        self.assertEqual(set(groups), {("p1", "sedated")})
        self.assertEqual(groups[("p1", "sedated")]["correct"], 10)
        self.assertEqual(len(report["quarantined"]), 2)

    def test_cambridge_metadata_disagreement_is_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_cambridge(root, "p1", "3", subject="p2")
            groups, report = load_report(root, "cambridge")
        self.assertEqual(groups, {})
        self.assertIn("misfiled or renamed session", report["quarantined"][0]["reason"])
        self.assertIn("p2", report["quarantined"][0]["reason"])

    def test_cambridge_legacy_cache_is_quarantined(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_cache(root, "cambridge", "p1-3", correct=10)
            groups, report = load_report(root, "cambridge")
        self.assertEqual(groups, {})
        self.assertIn(provenance.LEGACY_REASON, report["quarantined"][0]["reason"])

    def test_cambridge_extractor_attestation(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_cache(root, "cambridge", "p1-3", correct=10)
            path = root / "cache-cambridge" / "p1-3.npz"
            self.assertFalse(provenance.cambridge_attested(path, "p1", "3"))
            write_cambridge(root, "p1", "3", correct=10)
            self.assertTrue(provenance.cambridge_attested(path, "p1", "3"))
            self.assertFalse(provenance.cambridge_attested(path, "p2", "3"))

    def test_quarantined_files_never_reach_the_analysis(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            write_source(root, EC)
            write_source(root, sed2(run=1))
            write_cache(root, "oslo", "1010-propofol")
            groups, report = load_report(root, "oslo")
        rows = summarize(groups, "oslo", "frontal")
        self.assertEqual({row["state"] for row in rows}, {"baseline", "sedated"})
        self.assertEqual(len(report["quarantined"]), 1)


if __name__ == "__main__":
    unittest.main()
