"""Run an offline research model on contiguous segments in physical microvolts."""

import argparse
from fractions import Fraction
import json
from pathlib import Path

import joblib
import numpy as np
from scipy import signal
from scipy.special import expit
from fit_seizures import apply_calibration, raw_scores
from waveforms import features, SECONDS, PAIRS


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


def score(task, montage, file, model_dir, blockade="unknown"):
    if blockade not in ("documented", "suspected", "reported-absent", "unknown"):
        raise ValueError("unknown blockade context")
    pairs = 2 if montage == "frontal" else 6 if task == "propofol" else 8
    segments, hz = read_session(file, pairs)
    if task == "propofol":
        spec = json.loads((model_dir / "propofol-research-weights.json").read_text())["models"][
            montage
        ]
        rate = Fraction(125 / hz).limit_denominator(8192)
        fx = []
        for block in segments:
            b = signal.resample_poly(block, rate.numerator, rate.denominator, axis=1)
            if b.shape[1] >= 125 * SECONDS:
                fx.append(features(b, 125))
        if not fx:
            raise ValueError("no complete 8-second window")
        e = np.concatenate(fx)
        usable = e[np.isfinite(e).all(axis=(1, 2))]
        if len(usable) < 2:
            return {"status": "insufficient usable EEG", "eligible_windows": len(usable)}
        if blockade in ("documented", "suspected"):
            # These models have never been validated to infer awareness during paralysis.
            # Return signal descriptors, without mapping them to consciousness or drug exposure.
            rel = usable[..., 1:4].astype(float)
            valid = np.isfinite(rel).all(axis=2) & (rel.min(axis=2) > 0)
            if not valid.all():
                return {"status": "insufficient usable EEG", "eligible_windows": 0}
            ratios = np.median(np.log(rel[..., 1:] / rel[..., :1]), axis=(0, 1))
            return {
                "status": "abstained from depth interpretation",
                "blockade_context": blockade,
                "consciousness_inference": None,
                "eligible_windows": len(usable),
                "total_windows": len(e),
                "EEG_log_theta_to_delta": float(ratios[0]),
                "EEG_log_alpha_to_delta": float(ratios[1]),
                "reason": "Neuromuscular blockade can suppress EMG while awareness persists.",
            }
        meds = np.median(usable.reshape(len(usable), pairs // 2, 2, -1), axis=(0, 2)).ravel()
        v = (meds - spec["mean"]) / spec["scale"]
        return {
            "status": "research replay",
            "target": "propofol protocol state",
            "blockade_context": blockade,
            "consciousness_inference": None,
            "eligible_windows": len(usable),
            "total_windows": len(e),
            "session_score": float(expit(v @ spec["coef"] + spec["intercept"])),
        }
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
        valid += sum(u)
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
        "status": "research replay" if valid else "insufficient usable EEG",
        "target": "neonatal seizure-pattern events",
        "eligible_windows": int(valid),
        "total_windows": total,
        "candidate_events": alerts,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", choices=["propofol", "neonatal"])
    parser.add_argument("montage", choices=["frontal", "broader"])
    parser.add_argument("input", type=Path)
    parser.add_argument("--models", type=Path, default=Path(__file__).parent / "results")
    parser.add_argument(
        "--blockade",
        choices=["documented", "suspected", "reported-absent", "unknown"],
        default="unknown",
        help="Recorded or suspected exposure, supplied independently of the EEG",
    )
    args = parser.parse_args()
    print(
        json.dumps(
            score(args.task, args.montage, args.input, args.models, args.blockade),
            allow_nan=False,
        )
    )
