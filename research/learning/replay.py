"""Replay an offline research model on contiguous segments in physical microvolts.

Policy (retrospective research only)
------------------------------------
The default output is a *descriptor* report. It never maps EEG to
consciousness, awareness or a current depth, and it never loads model weights.
A depth-like number is produced only when all of the following hold:

* the caller passes the explicit offline opt-in ``--allow-research-score``;
* an independently recorded context documents the *absence* of neuromuscular
  blockade for every interval that contributes signal;
* montage, reference and calibration are compatible with the fitted model;
* the EEG is clean and the usable coverage is adequate.

Anything documented, suspected, omitted, unknown, conflicting, mixed, expired
or insufficiently evidenced abstains before the weight files are read. The
field ``consciousness_inference`` is always ``None``.

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

# A handful of usable windows cannot support a session-level statement. Two
# usable windows out of one hundred is not a sparse estimate, it is noise.
MIN_USABLE_WINDOWS = 8
MIN_USABLE_FRACTION = 0.5
DEFAULT_MAX_CONTEXT_AGE_HOURS = 24.0


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


def normalize_context(raw):
    """Validate and normalise a context document.

    The document is the independent record of what was and was not given.
    Unknown keys are ignored; invalid values are rejected, never coerced.
    """
    if not isinstance(raw, dict):
        raise ContextError("context must be a JSON object")
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

    intervals = raw.get("intervals", [])
    if intervals is None:
        intervals = []
    if not isinstance(intervals, list):
        raise ContextError("intervals must be a list")

    normalized = []
    for index, item in enumerate(intervals):
        if not isinstance(item, dict):
            raise ContextError(f"intervals[{index}] must be an object")
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
                "gap_before": bool(item.get("gap_before", False)),
                "bolus_within_interval": bool(item.get("bolus_within_interval", False)),
                "reversal_uncertain": bool(item.get("reversal_uncertain", False)),
                "case_changed": bool(item.get("case_changed", False)),
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
        "bolus_within_interval": bool(raw.get("bolus_within_interval", False)),
        "reversal_uncertain": bool(raw.get("reversal_uncertain", False)),
        "case_changed": bool(raw.get("case_changed", False)),
        "gap_before": bool(raw.get("gap_before", False)),
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


def _context_verdict(context, montage, blockade):
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
        if not row["reference"] or row["reference"].strip().lower() in ("unknown", "unspecified"):
            return False, "the documented reference is not usable"
        if not row["calibration"] or row["calibration"].strip().lower() not in (
            "uv",
            "microvolt",
            "microvolts",
        ):
            return False, "the documented calibration is not physical microvolts"

    acquired = context["acquired_at"] or _now()
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
    return True, "documented blockade absence covers every contributing interval"


def read_session(file, mode):
    with np.load(file, allow_pickle=False) as data:
        if str(data["unit"].item()) != "uV":
            raise ValueError("input unit must be uV")
        hz = float(data["hz"].item())
        if not np.isfinite(hz) or not 100 <= hz <= 10000:
            raise ValueError("unsupported sample rate")
        names = [str(v).upper().replace("–", "-") for v in data["derivations"]]
        x = np.asarray(data["waveforms"], dtype="float64")
    if x.ndim == 2:
        x = x[None, :, :]
    if x.ndim != 3 or x.shape[1] != len(names):
        raise ValueError("expected segments × derivations × samples")
    required = ["-".join(v) for v in PAIRS[:mode]]
    if any(names.count(n) != 1 for n in required):
        raise ValueError("missing or ambiguous derivation")
    return x[:, [names.index(n) for n in required], :], hz


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


def _insufficient(coverage, reason):
    return {
        "status": INSUFFICIENT_STATUS,
        "context": {"blockade": None},
        "consciousness_inference": None,
        SCORE_NAME: None,
        "reason": reason,
        "coverage": coverage,
    }


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
    resolved_blockade = merge_blockade(blockade, context)
    if task == "neonatal":
        return _neonatal(montage, file, model_dir)

    pairs = 2 if montage == "frontal" else 6
    segments, hz = read_session(file, pairs)

    # Descriptor path first: no weight file is opened before this point.
    rows = _segment_coverage(segments, hz)
    coverage = _coverage(rows)
    if any(row["status"] == "partial" for row in rows):
        return _insufficient(coverage, "a segment is partial; scores require complete windows")
    if any(row["status"] == "qc_error" for row in rows):
        return _insufficient(coverage, "a segment failed signal-quality checks")
    if (
        coverage["usable_windows"] < MIN_USABLE_WINDOWS
        or coverage["usable_fraction"] < MIN_USABLE_FRACTION
    ):
        return _insufficient(coverage, "usable EEG coverage is sparse")

    rate = Fraction(125 / hz).limit_denominator(8192)
    fx = []
    for block in segments:
        b = signal.resample_poly(block, rate.numerator, rate.denominator, axis=1)
        if b.shape[1] >= 125 * SECONDS:
            fx.append(features(b, 125))
    if not fx:
        return _insufficient(coverage, "no complete 8-second window")
    e = np.concatenate(fx)
    usable = e[np.isfinite(e).all(axis=(1, 2))]
    if len(usable) < MIN_USABLE_WINDOWS:
        return _insufficient(coverage, "usable EEG coverage is sparse")

    descriptors = _low_band_descriptors(usable)
    if descriptors is None:
        return _insufficient(coverage, "relative low-band power is unusable")

    base = {
        "target": "propofol protocol state",
        "blockade_context": resolved_blockade,
        "consciousness_inference": None,
        SCORE_NAME: None,
        "coverage": coverage,
        "descriptors": descriptors,
    }

    # No context and no flag is the default: signal descriptors only.
    if context is None and blockade is None:
        return {
            **base,
            "status": DESCRIPTOR_STATUS,
            "reason": "descriptor-only default; no research score was requested",
        }

    eligible, verdict = _context_verdict(context, montage, resolved_blockade)
    if not eligible:
        status = (
            DESCRIPTOR_STATUS
            if resolved_blockade in ("documented", "suspected")
            else ABSTAINED_STATUS
        )
        return {**base, "status": status, "reason": verdict}

    if not allow_research_score:
        return {
            **base,
            "status": DESCRIPTOR_STATUS,
            "reason": "research score requires the explicit offline --allow-research-score opt-in",
        }

    weights_path = model_dir / "propofol-research-weights.json"
    if not weights_path.exists():
        raise ValueError("propofol research weights are missing")
    spec = json.loads(weights_path.read_text())["models"][montage]
    meds = np.median(usable.reshape(len(usable), pairs // 2, 2, -1), axis=(0, 2)).ravel()
    v = (meds - np.asarray(spec["mean"], dtype=float)) / np.asarray(spec["scale"], dtype=float)
    value = float(expit(v @ np.asarray(spec["coef"], dtype=float) + float(spec["intercept"])))
    if not math.isfinite(value):
        return _insufficient(coverage, "the fitted model produced a non-finite value")
    return {
        **base,
        "status": SCORE_STATUS,
        "reason": "documented blockade absence, explicit opt-in and adequate clean EEG",
        SCORE_NAME: value,
    }


def _neonatal(montage, file, model_dir):
    """Neonatal seizure-pattern replay. Deliberately separate from the propofol path."""
    pairs = 2 if montage == "frontal" else 8
    segments, hz = read_session(file, pairs)
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
        "consciousness_inference": None,
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

    context = normalize_context(json.loads(args.context.read_text())) if args.context else None
    try:
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
        parser.error(str(exc))
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
