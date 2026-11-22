"""Replay an offline research model on contiguous segments in physical microvolts.

Policy (retrospective research only)
------------------------------------
The default output is a *descriptor* report. It never maps EEG to
consciousness, awareness or a current depth, and it never loads model weights.
A depth-like number is produced only when all of the following hold:

* the caller passes the explicit offline opt-in ``--allow-research-score``;
* the recording carries an acquisition case identity and acquisition time that
  match an independently recorded context;
* that context documents the *absence* of neuromuscular blockade for every
  second of the recording, using a qualified reference and physical
  microvolt calibration;
* the recording's segment offsets are known, so the documented intervals can
  be matched to the signal that actually contributed;
* montage, reference and calibration are compatible with the fitted model;
* the EEG is clean and the usable coverage is adequate.

Anything documented, suspected, omitted, unknown, conflicting, mixed, expired
or insufficiently evidenced abstains before the weight files are read. Embedded
metadata in the recording is never allowed to override absent evidence, and a
recording without acquisition identity, acquisition time or segment offsets is
not scored. The field ``consciousness_inference`` is always ``None``.

The propofol number is named ``propofol_protocol_state_score`` because that is
all it is: a research classifier of a named propofol protocol state across two
small cohorts. It is not a measure of awareness, sedation adequacy or a
validated anaesthetic endpoint.
"""

import argparse
from datetime import datetime, timezone
from fractions import Fraction
import json
import math
from pathlib import Path

import joblib
import numpy as np
from scipy import signal
from scipy.special import expit
from fit_seizures import apply_calibration, raw_scores
from waveforms import features, SECONDS, PAIRS

BLOCKADE_STATES = ("documented", "suspected", "reported-absent", "unknown")
SCORE_NAME = "propofol_protocol_state_score"
DESCRIPTOR_STATUS = "descriptor-only"
ABSTAINED_STATUS = "abstained"
INSUFFICIENT_STATUS = "insufficient usable EEG"
SCORE_STATUS = "research score"
MODEL_NAME = "propofol-protocol-state"

# A handful of usable windows cannot support a session-level statement. Two
# usable windows out of one hundred is not a sparse estimate, it is noise.
MIN_USABLE_WINDOWS = 8
MIN_USABLE_FRACTION = 0.5
DEFAULT_MAX_CONTEXT_AGE_HOURS = 24.0
# The caller may tighten the evidence window, never widen it. Evidence older
# than this is not "documented absence for this recording", whatever the file
# says.
MAX_CONTEXT_AGE_HOURS_CAP = 24.0
TOLERANCE = 1e-6

CONTEXT_KEYS = {
    "blockade",
    "case_id",
    "acquired_at",
    "max_context_age_hours",
    "intervals",
    "bolus_within_interval",
    "reversal_uncertain",
    "case_changed",
    "gap_before",
}
INTERVAL_KEYS = {
    "start",
    "end",
    "absence_documented",
    "source",
    "recorded_at",
    "montage",
    "reference",
    "calibration",
    "gap_before",
    "bolus_within_interval",
    "reversal_uncertain",
    "case_changed",
}
SAFETY_FLAGS = ("gap_before", "bolus_within_interval", "reversal_uncertain", "case_changed")

# Only references that name an actual acquisition montage can qualify the
# evidence. A free-text label such as "arbitrary" describes nothing and must
# not be accepted just because it is not the word "unknown".
QUALIFIED_REFERENCES = {
    "mastoid",
    "left mastoid",
    "right mastoid",
    "linked mastoids",
    "linked mastoid",
    "linked ears",
    "ear",
    "ears",
    "average",
    "common average",
    "cz",
    "vertex",
    "nose",
    "nose reference",
    "forehead",
    "afz",
    "tp9",
    "tp10",
}

EMBEDDED_CASE_KEYS = ("case_id", "caseId")
EMBEDDED_BLOCKADE_KEYS = ("blockade_context", "blockade", "blockadeContext")
SEGMENT_OFFSET_KEYS = ("segment_offsets", "segment_start_seconds", "segment_starts")


class ContextError(ValueError):
    """The supplied context is malformed; refuse rather than guess."""


def _now():
    return datetime.now(timezone.utc)


def _parse_time(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ContextError(f"{field} must be an ISO-8601 timestamp")
    text = value.strip().replace("Z", "+00:00")
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ContextError(f"{field} is not a valid ISO-8601 timestamp") from exc
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc)


def _finite(value, field):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContextError(f"{field} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise ContextError(f"{field} must be finite")
    return number


def _boolean(raw, key, field):
    """Safety flags must be a real boolean; a string is not evidence."""
    if key not in raw:
        return False
    value = raw[key]
    if not isinstance(value, bool):
        raise ContextError(f"{field} must be true or false")
    return value


def _normalise_reference(value):
    if not isinstance(value, str):
        return ""
    text = value.strip().lower().replace("-", " ").replace("_", " ")
    return " ".join(text.split())


def normalize_context(raw):
    """Validate and normalise a context document.

    The document is the independent record of what was and was not given.
    Unknown keys are rejected rather than ignored: a misspelt safety flag must
    not silently disappear. Invalid values are rejected, never coerced.
    """
    if not isinstance(raw, dict):
        raise ContextError("context must be a JSON object")
    unknown = set(raw) - CONTEXT_KEYS
    if unknown:
        raise ContextError(f"unknown context keys: {sorted(unknown)}")
    blockade = raw.get("blockade", "unknown")
    if blockade not in BLOCKADE_STATES:
        raise ContextError(f"unknown blockade context: {blockade!r}")
    case_id = raw.get("case_id")
    if case_id is not None and (not isinstance(case_id, str) or not case_id.strip()):
        raise ContextError("case_id must be a non-empty string when supplied")
    acquired = raw.get("acquired_at")
    acquired_at = _parse_time(acquired, "acquired_at") if acquired is not None else None
    age_limit = raw.get("max_context_age_hours", DEFAULT_MAX_CONTEXT_AGE_HOURS)
    age_limit = _finite(age_limit, "max_context_age_hours")
    if age_limit <= 0:
        raise ContextError("max_context_age_hours must be greater than zero")
    if age_limit > MAX_CONTEXT_AGE_HOURS_CAP:
        raise ContextError(
            f"max_context_age_hours may not exceed {MAX_CONTEXT_AGE_HOURS_CAP:g} hours"
        )

    intervals = raw.get("intervals", [])
    if intervals is None:
        intervals = []
    if not isinstance(intervals, list):
        raise ContextError("intervals must be a list")

    normalized = []
    for index, item in enumerate(intervals):
        if not isinstance(item, dict):
            raise ContextError(f"intervals[{index}] must be an object")
        extra = set(item) - INTERVAL_KEYS
        if extra:
            raise ContextError(f"intervals[{index}] has unknown keys: {sorted(extra)}")
        start = _finite(item.get("start"), f"intervals[{index}].start")
        end = _finite(item.get("end"), f"intervals[{index}].end")
        if start < 0 or end <= start:
            raise ContextError(f"intervals[{index}] has an invalid time range")
        absence = item.get("absence_documented")
        if not isinstance(absence, bool):
            raise ContextError(f"intervals[{index}].absence_documented must be true or false")
        source = item.get("source")
        recorded = item.get("recorded_at")
        montage = item.get("montage")
        reference = item.get("reference")
        calibration = item.get("calibration")
        if absence:
            for name, value in (
                ("source", source),
                ("recorded_at", recorded),
                ("montage", montage),
                ("reference", reference),
                ("calibration", calibration),
            ):
                if not isinstance(value, str) or not value.strip():
                    raise ContextError(
                        f"intervals[{index}] documents absence without {name}"
                    )
        normalized.append(
            {
                "start": start,
                "end": end,
                "absence_documented": absence,
                "source": source,
                "recorded_at": recorded,
                "recorded_time": _parse_time(recorded, f"intervals[{index}].recorded_at")
                if recorded is not None
                else None,
                "montage": montage,
                "reference": reference,
                "calibration": calibration,
                "gap_before": _boolean(item, "gap_before", f"intervals[{index}].gap_before"),
                "bolus_within_interval": _boolean(
                    item, "bolus_within_interval", f"intervals[{index}].bolus_within_interval"
                ),
                "reversal_uncertain": _boolean(
                    item, "reversal_uncertain", f"intervals[{index}].reversal_uncertain"
                ),
                "case_changed": _boolean(
                    item, "case_changed", f"intervals[{index}].case_changed"
                ),
            }
        )

    normalized.sort(key=lambda row: (row["start"], row["end"]))
    for previous, current in zip(normalized, normalized[1:]):
        if current["start"] < previous["end"]:
            raise ContextError("intervals overlap; refusing to merge them")

    return {
        "blockade": blockade,
        "case_id": case_id.strip() if isinstance(case_id, str) else None,
        "acquired_at": acquired_at,
        "max_context_age_hours": age_limit,
        "intervals": normalized,
        "bolus_within_interval": _boolean(raw, "bolus_within_interval", "bolus_within_interval"),
        "reversal_uncertain": _boolean(raw, "reversal_uncertain", "reversal_uncertain"),
        "case_changed": _boolean(raw, "case_changed", "case_changed"),
        "gap_before": _boolean(raw, "gap_before", "gap_before"),
    }


def merge_blockade(cli_blockade, context):
    """Resolve a CLI flag against a context file, conservatively.

    A disagreement is a conflict, not a preference: the caller has to say which
    record is authoritative.
    """
    if context is None:
        return cli_blockade or "unknown"
    if cli_blockade is not None and cli_blockade != context["blockade"]:
        raise ContextError(
            "the --blockade flag conflicts with the context file; refusing to choose"
        )
    return context["blockade"]


def _context_verdict(context, spans, montage, blockade):
    """Return (eligible, reason) for a research score. Does not touch weights."""
    if blockade in ("documented", "suspected"):
        return (
            False,
            "neuromuscular blockade is documented or suspected; depth interpretation is withheld",
        )
    if blockade != "reported-absent":
        return False, "absence of neuromuscular blockade is not independently documented"
    if context is None:
        return False, "no independent blockade context was supplied"
    if context["case_id"] is None:
        return False, "the context carries no acquisition case identity"
    if context["acquired_at"] is None:
        return False, "the context carries no acquisition time"

    intervals = context["intervals"]
    if not intervals:
        return False, "no documented blockade-absence interval covers the recording"
    if any(not row["absence_documented"] for row in intervals):
        return False, "a contributing interval lacks documented blockade absence"
    if any(row["bolus_within_interval"] for row in intervals) or context[
        "bolus_within_interval"
    ]:
        return False, "a contributing interval contains a bolus"
    if any(row["reversal_uncertain"] for row in intervals) or context["reversal_uncertain"]:
        return False, "reversal is uncertain within a contributing interval"
    if any(row["case_changed"] for row in intervals) or context["case_changed"]:
        return False, "the case changed within a contributing interval"
    if context["gap_before"] or any(row["gap_before"] for row in intervals):
        return False, "a contributing interval starts after a gap; evidence cannot carry over"

    for previous, current in zip(intervals, intervals[1:]):
        if current["start"] != previous["end"]:
            return False, "contributing intervals are not contiguous; evidence cannot carry over"

    for row in intervals:
        if row["montage"] != montage:
            return False, f"documented montage {row['montage']!r} does not match {montage!r}"
        if _normalise_reference(row["reference"]) not in QUALIFIED_REFERENCES:
            return False, (
                f"documented reference {row['reference']!r} is not a qualified "
                "acquisition reference"
            )
        if not row["calibration"] or row["calibration"].strip().lower() not in (
            "uv",
            "µv",
            "μv",
            "microvolt",
            "microvolts",
        ):
            return False, "the documented calibration is not physical microvolts"

    # The documented absence must cover the actual recording interval, from
    # the first acquired sample to the last, not just the part that happened
    # to be convenient to annotate.
    if spans is None:
        return False, "the recording has no usable segment timing"
    rec_start = spans[0][0]
    rec_end = spans[-1][1]
    if intervals[0]["start"] > rec_start + TOLERANCE:
        return False, "documented blockade absence does not cover the start of the recording"
    if intervals[-1]["end"] < rec_end - TOLERANCE:
        return False, "documented blockade absence does not cover the end of the recording"
    for start, end in spans:
        if not any(
            row["start"] <= start + TOLERANCE and end <= row["end"] + TOLERANCE
            for row in intervals
        ):
            return False, "a recorded segment is not fully covered by documented absence"

    acquired = context["acquired_at"]
    limit_hours = context["max_context_age_hours"]
    for row in intervals:
        recorded = row["recorded_time"]
        if recorded is None:
            return False, "a documented interval has no provenance time"
        if recorded > acquired:
            return False, "documented evidence post-dates the recording"
        age_hours = (acquired - recorded).total_seconds() / 3600.0
        if age_hours > limit_hours:
            return False, "documented evidence is stale for the recording"
    return True, "documented blockade absence covers every recorded segment"


def _scalar(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, np.ndarray) and value.ndim == 0:
        return _scalar(value.item())
    return value


def read_session(file, mode):
    with np.load(file, allow_pickle=False) as data:
        if str(_scalar(data["unit"])) != "uV":
            raise ValueError("input unit must be uV")
        hz = float(_scalar(data["hz"]))
        if not np.isfinite(hz) or not 100 <= hz <= 10000:
            raise ValueError("unsupported sample rate")
        names = [str(v).upper().replace("–", "-") for v in data["derivations"]]
        x = np.asarray(data["waveforms"], dtype="float64")
        embedded = {}
        for key in EMBEDDED_CASE_KEYS + EMBEDDED_BLOCKADE_KEYS:
            if key in data.files:
                embedded[key] = _scalar(data[key])
        offsets = None
        for key in SEGMENT_OFFSET_KEYS:
            if key in data.files:
                offsets = [float(v) for v in np.asarray(data[key], dtype="float64").ravel()]
                break
    if x.ndim == 2:
        x = x[None, :, :]
    if x.ndim != 3 or x.shape[1] != len(names):
        raise ValueError("expected segments × derivations × samples")
    required = ["-".join(v) for v in PAIRS[:mode]]
    if any(names.count(n) != 1 for n in required):
        raise ValueError("missing or ambiguous derivation")
    embedded["offsets"] = offsets
    return x[:, [names.index(n) for n in required], :], hz, embedded


def _embedded_case_id(embedded):
    values = {
        str(embedded[key]).strip()
        for key in EMBEDDED_CASE_KEYS
        if key in embedded and embedded[key] not in (None, "")
    }
    if len(values) > 1:
        return None, True
    return (next(iter(values)) if values else None), False


def _embedded_blockade(embedded):
    values = {
        str(embedded[key]).strip().lower()
        for key in EMBEDDED_BLOCKADE_KEYS
        if key in embedded and embedded[key] not in (None, "")
    }
    if len(values) > 1:
        return None, True
    if not values:
        return None, False
    value = next(iter(values))
    # Unsupported embedded metadata fails closed rather than being ignored.
    return (value if value in BLOCKADE_STATES else "unknown"), False


def _recording_spans(segments, hz, offsets):
    """Map each segment to acquisition seconds, or refuse when timing is unknown."""
    durations = [block.shape[1] / hz for block in segments]
    if offsets is None:
        if len(segments) == 1:
            offsets = [0.0]
        else:
            return None, "multiple segments without acquisition offsets; timing is unknown"
    if len(offsets) != len(segments):
        return None, "segment offsets do not match the number of segments"
    spans = []
    previous_end = None
    for offset, duration in zip(offsets, durations):
        if not math.isfinite(offset) or offset < 0:
            return None, "a segment offset is not a finite non-negative time"
        if previous_end is not None and offset < previous_end - TOLERANCE:
            return None, "segment offsets overlap or run backwards"
        spans.append((offset, offset + duration))
        previous_end = offset + duration
    return spans, None


def _segment_coverage(segments, hz):
    """Per-segment window accounting, including partial tails and QC failures."""
    window = round(SECONDS * hz)
    rows = []
    for index, block in enumerate(segments):
        complete = block.shape[1] // window
        partial = block.shape[1] % window != 0
        e = features(block, hz) if complete else np.empty((0, block.shape[0], 13))
        usable = int(np.isfinite(e).all(axis=(1, 2)).sum()) if len(e) else 0
        status = "complete"
        if partial:
            status = "partial"
        elif complete == 0:
            status = "partial"
        elif usable == 0:
            status = "qc_error"
        rows.append(
            {
                "index": index,
                "complete_windows": int(complete),
                "usable_windows": usable,
                "partial": partial,
                "status": status,
            }
        )
    return rows


def _low_band_descriptors(usable):
    """Theta/delta and alpha/delta log ratios from relative band powers.

    The shared broadband denominator cancels, so a change confined to
    high-frequency power cannot move these ratios.
    """
    rel = usable[..., 1:4].astype(float)
    valid = np.isfinite(rel).all(axis=2) & (rel.min(axis=2) > 0)
    if not valid.all():
        return None
    ratios = np.median(np.log(rel[..., 1:] / rel[..., :1]), axis=(0, 1))
    return {
        "EEG_log_theta_to_delta": float(ratios[0]),
        "EEG_log_alpha_to_delta": float(ratios[1]),
    }


def _coverage(rows):
    total = sum(row["complete_windows"] for row in rows)
    usable = sum(row["usable_windows"] for row in rows)
    return {
        "segments": rows,
        "total_windows": total,
        "usable_windows": usable,
        "usable_fraction": (usable / total) if total else 0.0,
    }


def _resolved_context(context, blockade):
    return {
        "blockade": blockade,
        "case_id": context["case_id"] if context else None,
        "acquired_at": context["acquired_at"].isoformat() if context and context["acquired_at"] else None,
    }


def _payload(status, reason, *, context, blockade, coverage, descriptors, score=None, model=None):
    """Every non-scoring result carries the same resolved shape."""
    result = {
        "status": status,
        "context": _resolved_context(context, blockade),
        "blockade_context": blockade,
        "reason": reason,
        "coverage": coverage,
        "descriptors": descriptors,
        "consciousness_inference": None,
        SCORE_NAME: score,
    }
    if model is not None:
        result["model"] = model
    return result


def _error_result(reason, blockade=None, context=None):
    return _payload(
        ABSTAINED_STATUS,
        reason,
        context=context,
        blockade=blockade,
        coverage=None,
        descriptors=None,
    )


def _analyse(segments, hz):
    """Coverage and low-band descriptors. Never opens a weight file."""
    rows = _segment_coverage(segments, hz)
    coverage = _coverage(rows)
    usable = None
    descriptors = None
    if not any(row["status"] == "partial" for row in rows):
        rate = Fraction(125 / hz).limit_denominator(8192)
        fx = []
        for block in segments:
            b = signal.resample_poly(block, rate.numerator, rate.denominator, axis=1)
            if b.shape[1] >= 125 * SECONDS:
                fx.append(features(b, 125))
        if fx:
            e = np.concatenate(fx)
            usable = e[np.isfinite(e).all(axis=(1, 2))]
            if len(usable):
                descriptors = _low_band_descriptors(usable)
    return coverage, usable, descriptors


def score(
    task,
    montage,
    file,
    model_dir,
    blockade=None,
    *,
    context=None,
    allow_research_score=False,
):
    """Run one offline research replay.

    ``context`` is the normalised context dict (or ``None``). ``blockade`` is a
    legacy single-word flag; when both are supplied they must agree.
    """
    try:
        resolved_blockade = merge_blockade(blockade, context)
    except ContextError as exc:
        return _error_result(str(exc), blockade, context)
    if task == "neonatal":
        return _neonatal(montage, file, model_dir)

    pairs = 2 if montage == "frontal" else 6
    segments, hz, embedded = read_session(file, pairs)
    coverage, usable, descriptors = _analyse(segments, hz)
    spans, span_error = _recording_spans(segments, hz, embedded.get("offsets"))

    if any(row["status"] == "partial" for row in coverage["segments"]):
        return _payload(
            INSUFFICIENT_STATUS,
            "a segment is partial; scores require complete windows",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if any(row["status"] == "qc_error" for row in coverage["segments"]):
        return _payload(
            INSUFFICIENT_STATUS,
            "a segment failed signal-quality checks",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if (
        coverage["usable_windows"] < MIN_USABLE_WINDOWS
        or coverage["usable_fraction"] < MIN_USABLE_FRACTION
    ):
        return _payload(
            INSUFFICIENT_STATUS,
            "usable EEG coverage is sparse",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if usable is None or descriptors is None:
        return _payload(
            INSUFFICIENT_STATUS,
            "the clean windows do not support a low-band descriptor",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )

    # A documented or suspected exposure is withheld on the exposure record
    # alone, before the identity checks and before any weight file is read.
    if resolved_blockade in ("documented", "suspected"):
        return _payload(
            DESCRIPTOR_STATUS,
            "neuromuscular blockade is documented or suspected; depth interpretation is withheld",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if resolved_blockade != "reported-absent":
        if context is None and blockade is None:
            return _payload(
                DESCRIPTOR_STATUS,
                "descriptor-only default; no research context was supplied",
                context=context,
                blockade=resolved_blockade,
                coverage=coverage,
                descriptors=descriptors,
            )
        return _payload(
            ABSTAINED_STATUS,
            "absence of neuromuscular blockade is not independently documented",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )

    # Embedded recording metadata is never independent evidence, and it is
    # never allowed to contradict the sidecar silently.
    embedded_case, case_conflict = _embedded_case_id(embedded)
    embedded_blockade, blockade_conflict = _embedded_blockade(embedded)
    if case_conflict:
        return _payload(
            ABSTAINED_STATUS,
            "the recording carries conflicting acquisition case identities",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if blockade_conflict:
        return _payload(
            ABSTAINED_STATUS,
            "the recording carries conflicting embedded blockade metadata",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if embedded_blockade in ("documented", "suspected", "unknown"):
        return _payload(
            ABSTAINED_STATUS,
            "the recording itself records blockade exposure or unknown status; "
            "depth interpretation is withheld",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if embedded_blockade is not None and embedded_blockade != resolved_blockade:
        return _payload(
            ABSTAINED_STATUS,
            "the recording's embedded blockade context conflicts with the supplied context",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if embedded_blockade == "reported-absent" and context is None:
        return _payload(
            ABSTAINED_STATUS,
            "embedded absence metadata is not an independent record",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if embedded_case is None:
        return _payload(
            ABSTAINED_STATUS,
            "the recording carries no acquisition case identity",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if context is None or context["case_id"] is None:
        return _payload(
            ABSTAINED_STATUS,
            "no acquisition case identity was supplied with the context",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if embedded_case != context["case_id"]:
        return _payload(
            ABSTAINED_STATUS,
            "the recording's acquisition case identity does not match the supplied context",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    if spans is None:
        return _payload(
            ABSTAINED_STATUS,
            span_error or "the recording has no usable segment timing",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )

    eligible, verdict = _context_verdict(context, spans, montage, resolved_blockade)
    if not eligible:
        status = (
            DESCRIPTOR_STATUS
            if resolved_blockade in ("documented", "suspected")
            else ABSTAINED_STATUS
        )
        return _payload(
            status,
            verdict,
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )

    if not allow_research_score:
        return _payload(
            DESCRIPTOR_STATUS,
            "research score requires the explicit offline --allow-research-score opt-in",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )

    weights_path = model_dir / "propofol-research-weights.json"
    if not weights_path.exists():
        raise ValueError("propofol research weights are missing")
    document = json.loads(weights_path.read_text())
    spec = document["models"][montage]
    meds = np.median(usable.reshape(len(usable), pairs // 2, 2, -1), axis=(0, 2)).ravel()
    v = (meds - np.asarray(spec["mean"], dtype=float)) / np.asarray(spec["scale"], dtype=float)
    value = float(expit(v @ np.asarray(spec["coef"], dtype=float) + float(spec["intercept"])))
    if not math.isfinite(value):
        return _payload(
            INSUFFICIENT_STATUS,
            "the fitted model produced a non-finite value",
            context=context,
            blockade=resolved_blockade,
            coverage=coverage,
            descriptors=descriptors,
        )
    model = {
        "name": MODEL_NAME,
        "version": document.get("version"),
        "montage": montage,
        "research_only": True,
        "clinical_depth": False,
        "purpose": document.get("purpose"),
    }
    return _payload(
        SCORE_STATUS,
        "documented blockade absence, explicit opt-in and adequate clean EEG",
        context=context,
        blockade=resolved_blockade,
        coverage=coverage,
        descriptors=descriptors,
        score=value,
        model=model,
    )


def _neonatal(montage, file, model_dir):
    """Neonatal seizure-pattern replay. Deliberately separate from the propofol path."""
    pairs = 2 if montage == "frontal" else 8
    segments, hz, _embedded = read_session(file, pairs)
    estimator = joblib.load(model_dir / f"neonatal-{montage}.joblib")
    if not np.isclose(hz, 256):
        raise ValueError("neonatal replay expects the 256 Hz Helsinki acquisition rate")
    alerts = []
    total = 0
    valid = 0
    for blocknr, block in enumerate(segments):
        if block.shape[1] < hz * SECONDS:
            continue
        e = features(block, hz)
        u = np.isfinite(e).all(axis=(1, 2))
        total += len(e)
        valid += int(u.sum())
        b = e.reshape(len(e), pairs // 2, 2, -1)
        x = np.concatenate([b.min(axis=2), b.max(axis=2)], axis=2).reshape(len(e), -1)
        p = apply_calibration(
            estimator["calibration"],
            raw_scores(estimator["model"], {"usable": u, "x": x, "y": np.zeros(len(e))}),
        )
        high = np.isfinite(p) & (p >= estimator["threshold"])
        confirmed = high & np.r_[False, high[:-1]]
        starts = np.flatnonzero(confirmed & ~np.r_[False, confirmed[:-1]])
        alerts += [
            {"segment": blocknr, "seconds_from_segment_start": int((i + 1) * SECONDS)}
            for i in starts
        ]
    return {
        "status": "research replay" if valid else INSUFFICIENT_STATUS,
        "target": "neonatal seizure-pattern events",
        "context": {"blockade": None, "case_id": None, "acquired_at": None},
        "blockade_context": None,
        "reason": "neonatal seizure-pattern replay; no depth or awareness inference",
        "coverage": None,
        "descriptors": None,
        "consciousness_inference": None,
        SCORE_NAME: None,
        "eligible_windows": int(valid),
        "total_windows": total,
        "candidate_events": alerts,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", choices=["propofol", "neonatal"])
    parser.add_argument("montage", choices=["frontal", "broader"])
    parser.add_argument("input", type=Path)
    parser.add_argument("--models", type=Path, default=Path(__file__).parent / "results")
    parser.add_argument(
        "--blockade",
        choices=list(BLOCKADE_STATES),
        default=None,
        help="Recorded or suspected exposure, supplied independently of the EEG",
    )
    parser.add_argument(
        "--context",
        type=Path,
        help="JSON context documenting blockade absence, provenance and interval coverage",
    )
    parser.add_argument(
        "--allow-research-score",
        action="store_true",
        help="Explicit offline opt-in for the research propofol protocol-state score",
    )
    args = parser.parse_args(argv)

    try:
        context = normalize_context(json.loads(args.context.read_text())) if args.context else None
        result = score(
            args.task,
            args.montage,
            args.input,
            args.models,
            args.blockade,
            context=context,
            allow_research_score=args.allow_research_score,
        )
    except ContextError as exc:
        # Input and conflict errors still produce the same structured,
        # non-scoring shape rather than an unstructured crash.
        result = _error_result(str(exc), args.blockade)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
