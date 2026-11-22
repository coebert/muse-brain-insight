"""Verified provenance for cached sessions.

The extractor writes an embedded provenance record with every cache it creates.
The fitter refuses a cache whose record does not agree with the cache filename
and the pinned acquisition entry, so a renamed or misfiled file cannot inherit
another participant's label.

A cache extracted before embedded provenance existed is unattested: its
filename alone cannot establish which participant or acquisition it holds. It
is quarantined unless its SHA-256 appears in ``legacy-cache-provenance.json``,
a checksum-pinned mapping from a cache digest to one source acquisition.
Re-running the extractor rebuilds unattested caches from the pinned sources.
"""

from functools import lru_cache
import hashlib
import json
from pathlib import Path

import numpy as np

from acquisitions import parse_source_path

MAPPING_PATH = Path(__file__).with_name("legacy-cache-provenance.json")
LEGACY_REASON = (
    "unverified legacy cache: no embedded provenance and no checksum-pinned "
    "source mapping"
)

OSLO_KEYS = ("subject", "task", "acq", "run", "condition")
CAMBRIDGE_KEYS = ("site", "subject", "level", "condition")


class ProvenanceError(ValueError):
    """A cache carries partial or unreadable provenance."""


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _value(data, key):
    try:
        return np.asarray(data[key]).item()
    except (TypeError, ValueError) as exc:
        raise ProvenanceError(f"{key} is not a scalar") from exc


def oslo_metadata(entry, source):
    """The embedded provenance the Oslo extractor writes for one cache."""
    return {
        "subject": str(entry["subject"]),
        "task": str(entry["task"]),
        "acq": str(entry["acq"]),
        "run": -1 if entry["run"] is None else int(entry["run"]),
        "condition": str(entry["condition"]),
        "source": str(source),
    }


def cambridge_metadata(subject, level, source):
    """The embedded provenance the Cambridge extractor writes for one cache."""
    return {
        "site": "cambridge",
        "subject": str(subject),
        "level": str(level),
        "condition": str(level),
        "source": str(source),
    }


def oslo_record(data):
    """Read an Oslo cache's embedded provenance, or ``None`` for a legacy cache.

    A cache with some provenance keys but not all of them is malformed and
    raises, because it cannot be told apart from a truncated write.
    """
    if not set(OSLO_KEYS) & set(data.files):
        return None
    missing = [key for key in OSLO_KEYS if key not in data.files]
    if missing:
        raise ProvenanceError(f"missing {', '.join(missing)}")
    run = _value(data, "run")
    try:
        run = None if run in (None, -1, "") else int(run)
    except (TypeError, ValueError) as exc:
        raise ProvenanceError(f"run is not an integer: {run!r}") from exc
    return {
        "subject": str(_value(data, "subject")),
        "task": str(_value(data, "task")),
        "acq": str(_value(data, "acq")),
        "run": run,
        "condition": str(_value(data, "condition")),
        "source": str(_value(data, "source")) if "source" in data.files else None,
    }


def cambridge_record(data):
    """Read a Cambridge cache's embedded provenance, or ``None`` when absent."""
    if not set(CAMBRIDGE_KEYS) & set(data.files):
        return None
    missing = [key for key in CAMBRIDGE_KEYS if key not in data.files]
    if missing:
        raise ProvenanceError(f"missing {', '.join(missing)}")
    return {
        "site": str(_value(data, "site")),
        "subject": str(_value(data, "subject")),
        "level": str(_value(data, "level")),
        "condition": str(_value(data, "condition")),
        "source": str(_value(data, "source")) if "source" in data.files else None,
    }


def oslo_record_problem(record, entry, origin="embedded"):
    """Return why a record disagrees with the pinned entry, or ``None``.

    The embedded source path, when present, must also parse to the same entry.
    """
    for key in ("subject", "task", "acq", "run", "condition"):
        if key not in record:
            return f"{origin} provenance is missing {key}"
    run = record["run"]
    try:
        run = None if run in (None, -1, "") else int(run)
    except (TypeError, ValueError):
        return f"{origin} run {run!r} is not an integer"
    values = {
        "subject": str(record["subject"]),
        "task": str(record["task"]),
        "acq": str(record["acq"]),
        "run": run,
        "condition": str(record["condition"]),
    }
    for key in ("subject", "task", "acq", "run", "condition"):
        if values[key] != entry[key]:
            return (
                "misfiled or renamed session: "
                f"{origin} {key} {values[key]!r} disagrees with cache name "
                f"{entry[key]!r}"
            )
    source = record.get("source")
    if source:
        parsed = parse_source_path(source)
        if parsed is None:
            return f"{origin} source {source!r} is outside the pinned acquisition grammar"
        for key in ("subject", "task", "acq", "run", "condition"):
            if parsed[key] != entry[key]:
                return (
                    "misfiled or renamed session: "
                    f"{origin} source {source!r} disagrees with cache name "
                    f"{key} {entry[key]!r}"
                )
    return None


def cambridge_record_problem(record, pid, level, origin="embedded"):
    """Return why a Cambridge record disagrees with the cache name, or ``None``."""
    expected = {
        "site": "cambridge",
        "subject": str(pid),
        "level": str(level),
        "condition": str(level),
    }
    for key, value in expected.items():
        if key not in record:
            return f"{origin} provenance is missing {key}"
        if str(record[key]) != value:
            return (
                "misfiled or renamed session: "
                f"{origin} {key} {record[key]!r} disagrees with cache name "
                f"{value!r}"
            )
    return None


@lru_cache(maxsize=1)
def _mapping():
    return json.loads(MAPPING_PATH.read_text())


def legacy_mapping():
    """The pinned legacy mapping, for inspection and tests."""
    return _mapping()


def legacy_record(digest, site, mapping=None):
    """A checksum-pinned legacy record for a cache digest, or ``None``."""
    sessions = (_mapping() if mapping is None else mapping).get("sessions", {})
    record = sessions.get(digest)
    if not isinstance(record, dict) or record.get("site") != site:
        return None
    return record


def oslo_attested(path, entry):
    """Whether an existing Oslo cache carries verified provenance."""
    try:
        with np.load(path, allow_pickle=False) as data:
            record = oslo_record(data)
    except (OSError, ValueError):
        return False
    if record is None:
        record = legacy_record(sha256_file(path), "oslo")
        origin = "checksum-pinned"
    else:
        origin = "embedded"
    return record is not None and oslo_record_problem(record, entry, origin) is None


def cambridge_attested(path, pid, level):
    """Whether an existing Cambridge cache carries verified provenance."""
    try:
        with np.load(path, allow_pickle=False) as data:
            record = cambridge_record(data)
    except (OSError, ValueError):
        return False
    if record is None:
        record = legacy_record(sha256_file(path), "cambridge")
        origin = "checksum-pinned"
    else:
        origin = "embedded"
    return record is not None and cambridge_record_problem(record, pid, level, origin) is None
