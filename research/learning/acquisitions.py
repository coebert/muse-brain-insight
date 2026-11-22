"""Anchored acquisition grammar for the two propofol cohorts.

The Oslo names are not free text. They are BIDS filenames in the pinned
OpenNeuro release ``ds005620`` (tag ``1.0.0``)::

    sub-<subject>_task-<task>_acq-<acquisition>[_run-<n>]_eeg.vhdr

``sedation.py`` extracts exactly three acquisitions, and its cache file is
named ``<subject>-<task>_acq-<acquisition>[_run-<n>].npz``:

    awake_acq-EC           eyes-closed awake baseline
    awake_acq-EO           eyes-open awake control (never baseline or sedated)
    sed2_acq-rest_run-<n>  one-minute resting EEG just before an awakening

``task-sed`` (with ``acq-tms``) is a different protocol arm and is not part of
the protocol-state comparison. Anything outside the grammar is unknown: it is
quarantined by the fitter, never guessed at and never given a stage.

Both parsers are anchored (``fullmatch``) so a renamed or truncated file cannot
inherit a stage from a suffix. The pinned manifest records the subjects and run
numbers that the release actually contains, so a cache file that names a
session the release does not contain is quarantined as misfiled rather than
silently trusted.
"""

from functools import lru_cache
import json
from pathlib import Path
import re

MANIFEST_PATH = Path(__file__).with_name("oslo-acquisitions.json")

# Source filename inside the release (anchored on the basename).
SOURCE_NAME = re.compile(
    r"^sub-(?P<subject>\d+)_task-(?P<task>awake|sed2)_acq-(?P<acq>EC|EO|rest)"
    r"(?:_run-(?P<run>\d+))?_eeg\.vhdr$"
)

# Cache filename written by sedation.py (anchored on the stem, or the full name).
CACHE_NAME = re.compile(
    r"^(?P<subject>\d+)-"
    r"(?P<condition>awake_acq-EC|awake_acq-EO|sed2_acq-rest_run-\d+)(?:\.npz)?$"
)

# Fixed acquisitions map directly to a stage. The run-numbered resting task is
# matched separately so an arbitrary suffix cannot qualify.
FIXED_ACQUISITIONS = {"awake_acq-EC": "baseline", "awake_acq-EO": "eyes_open"}
REST_RUN = re.compile(r"^sed2_acq-rest_run-(?P<run>\d+)$")


def condition_stage(condition):
    """Return the protocol stage for an acquisition condition, or ``None``."""
    if condition in FIXED_ACQUISITIONS:
        return FIXED_ACQUISITIONS[condition]
    if REST_RUN.fullmatch(condition):
        return "sedated"
    return None


def _entry(subject, task, acq, run):
    if task == "sed2":
        if acq != "rest" or run is None:
            return None
        condition = f"sed2_acq-rest_run-{run}"
    elif task == "awake" and acq in ("EC", "EO") and run is None:
        condition = f"awake_acq-{acq}"
    else:
        return None
    stage = condition_stage(condition)
    if stage is None:
        return None
    return {
        "subject": subject,
        "task": task,
        "acq": acq,
        "run": run,
        "condition": condition,
        "stage": stage,
    }


def parse_source_path(path):
    """Parse a release filename, or return ``None`` when it is not extracted."""
    name = str(path).rsplit("/", 1)[-1]
    match = SOURCE_NAME.fullmatch(name)
    if not match:
        return None
    run = int(match["run"]) if match["run"] is not None else None
    return _entry(match["subject"], match["task"], match["acq"], run)


def cache_name(entry):
    """The cache stem ``sedation.py`` writes for a parsed acquisition."""
    return f"{entry['subject']}-{entry['condition']}"


def parse_cache_name(stem):
    """Parse a cache stem, or return ``None`` when it is outside the grammar."""
    match = CACHE_NAME.fullmatch(str(stem))
    if not match:
        return None
    condition = match["condition"]
    if condition == "awake_acq-EC":
        return _entry(match["subject"], "awake", "EC", None)
    if condition == "awake_acq-EO":
        return _entry(match["subject"], "awake", "EO", None)
    run = REST_RUN.fullmatch(condition)
    return _entry(match["subject"], "sed2", "rest", int(run["run"]))


@lru_cache(maxsize=1)
def manifest():
    return json.loads(MANIFEST_PATH.read_text())


def manifest_problem(entry):
    """Return why a parsed acquisition is not in the pinned release, or ``None``."""
    subjects = manifest()["subjects"]
    row = subjects.get(entry["subject"])
    if row is None:
        return f"subject {entry['subject']} is not in the pinned acquisition manifest"
    if row.get("excluded"):
        return f"subject {entry['subject']} is excluded in the pinned release"
    if entry["condition"] == "awake_acq-EC":
        return None if row.get("awake_acq-EC") else "the release has no eyes-closed run"
    if entry["condition"] == "awake_acq-EO":
        return None if row.get("awake_acq-EO") else "the release has no eyes-open run"
    runs = row.get("sed2_acq-rest") or []
    if entry["run"] not in runs:
        return f"run {entry['run']} is not in the pinned acquisition manifest"
    return None


def condition_from_metadata(subject, task, acq, run):
    """Build a cache condition from embedded session metadata, or ``None``."""
    if not isinstance(subject, str) or not subject.strip():
        return None
    run = None if run in (None, -1, "") else int(run)
    entry = _entry(subject.strip(), str(task), str(acq), run)
    return entry["condition"] if entry else None
