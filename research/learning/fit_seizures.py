"""Grouped, cross-fitted neonatal seizure benchmarks with causal event scoring."""

import json
import sys
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
from waveforms import SECONDS, PAIRS, MEASURES


def bouts(indicator):
    edges = np.diff(np.r_[0, indicator, 0].astype(int))
    return np.stack([np.where(edges == 1)[0], np.where(edges == -1)[0]], axis=1)


def case(path, montage):
    with np.load(path) as z:
        votes = z["votes"]
        raw = z["x"][:, : 2 if montage == "frontal" else 8].copy()
        if len(votes) != len(raw) * SECONDS:
            raise ValueError("label length mismatch")
        # Every electrode selected for the montage must have passed the fixed signal checks.
        usable = np.isfinite(raw).all(axis=(1, 2))
        # Preserve left / right and localised transients via bilateral extrema.
        pairs = raw.reshape(len(raw), raw.shape[1] // 2, 2, len(MEASURES))
        x = np.concatenate([np.min(pairs, axis=2), np.max(pairs, axis=2)], axis=2).reshape(
            len(raw), -1
        )
    vote = votes.reshape(-1, SECONDS)
    # Train on entirely seizure-positive majority windows vs unanimously negative windows.
    strict = np.where((vote >= 2).all(axis=1), 1, np.where((vote == 0).all(axis=1), 0, -1))
    # Evaluate known windows, including disagreement, using the majority of seconds.
    y = np.where((vote >= 0).all(axis=1), ((vote >= 2).sum(axis=1) >= SECONDS / 2).astype(int), -1)
    events = [(int(a), int(b)) for a, b in bouts(votes >= 2) if b - a >= 10]
    return dict(x=x, usable=usable, y=y, strict=strict, votes=votes, events=events)


def train(cases, ids, kind):
    features = []
    targets = []
    weights = []
    for i in ids:
        r = cases[i]
        keep = r["usable"] & (r["strict"] >= 0)
        y = r["strict"][keep]
        if not len(y):
            continue
        features.append(r["x"][keep])
        targets.extend(y)
        weights.extend(np.full(len(y), 1 / len(y)))
    X = np.vstack(features)
    y = np.array(targets)
    w = np.array(weights)
    for c in (0, 1):
        w[y == c] *= len(w) / (2 * w[y == c].sum())
    if kind == "linear":
        model = make_pipeline(
            StandardScaler(), LogisticRegression(C=0.1, max_iter=700, random_state=941)
        )
        model.fit(X, y, standardscaler__sample_weight=w, logisticregression__sample_weight=w)
    else:
        model = HistGradientBoostingClassifier(
            max_iter=110,
            learning_rate=0.075,
            max_leaf_nodes=15,
            min_samples_leaf=45,
            l2_regularization=5.0,
            early_stopping=False,
            random_state=941,
        )
        model.fit(X, y, sample_weight=w)
    return model


def raw_scores(model, r):
    p = np.full(len(r["y"]), np.nan)
    v = r["usable"]
    if v.any():
        p[v] = model.predict_proba(r["x"][v])[:, 1]
    return p


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p)).reshape(-1, 1)


def calibrate(cases, ids, pred):
    p = []
    y = []
    for i in ids:
        r = cases[i]
        keep = (r["y"] >= 0) & np.isfinite(pred[i])
        p.extend(pred[i][keep])
        y.extend(r["y"][keep])
    return LogisticRegression(C=100, max_iter=300).fit(logit(p), y)


def apply_calibration(cal, p):
    mask = np.isfinite(p)
    out = p.copy()
    if mask.any():
        out[mask] = cal.predict_proba(logit(p[mask]))[:, 1]
    return out


def alarm_counts(r, p, t):
    # Raise at the end of two consecutive above-threshold windows. Never backdate the onset.
    hot = np.isfinite(p) & (p >= t)
    confirmed = hot & np.r_[False, hot[:-1]]
    starts = bouts(confirmed)[:, 0]
    times = (starts + 1) * SECONDS
    times = times[times < len(r["votes"])]
    votes = r["votes"]
    events = r["events"]
    hits = 0
    delays = []
    for a, b in events:
        matches = times[(times >= a) & (times < b)]
        if matches.size:
            hits += 1
            delays.append(int(matches[0] - a))
    no_seizure = (votes >= 0) & (votes < 2)
    # Represent the time the last completed decision is active, including ends of gaps.
    active = np.repeat(np.r_[False, confirmed[:-1]], SECONDS)
    return (
        np.array(
            [
                hits,
                len(events),
                no_seizure[times].sum(),
                no_seizure.sum(),
                (active & no_seizure).sum(),
                len(times),
            ],
            float,
        ),
        delays,
    )


def operating_point(cases, ids, preds):
    vals = np.concatenate([p[np.isfinite(p)] for p in preds.values()])
    # No alerts is always a feasible operating point. Constraints are calibrated per held-out fold.
    grid = np.unique(np.r_[np.quantile(vals, np.linspace(0.05, 0.999, 90)), 1.000001])
    best = None
    for t in grid:
        h, e, f, sec, occupied, alarms = sum(
            (alarm_counts(cases[i], preds[i], t)[0] for i in ids), np.zeros(6)
        )
        if f * 3600 / max(sec, 1) > 0.5 or occupied / max(sec, 1) > 0.05:
            continue
        rank = (h, -f, -occupied, t)
        if best is None or rank > best[0]:
            best = rank, float(t)
    return best[1]


def pooled(cases, scores, thresholds):
    ys = []
    ps = []
    delays = []
    patient = []
    good = total = tp = tn = pos = neg = 0
    for i, p in enumerate(scores):
        r = cases[i]
        known = r["y"] >= 0
        ok = known & np.isfinite(p)
        good += ok.sum()
        total += known.sum()
        ys.extend(r["y"][ok])
        ps.extend(p[ok])
        counts, lat = alarm_counts(r, p, thresholds[i])
        patient.append(counts)
        delays += lat
        y = r["y"][ok]
        pp = p[ok] >= thresholds[i]
        tp += sum(pp & (y == 1))
        pos += sum(y == 1)
        tn += sum(~pp & (y == 0))
        neg += sum(y == 0)
    y = np.array(ys)
    p = np.array(ps)
    pt = np.stack(patient)
    h, e, f, s, o, a = pt.sum(0)
    rng = np.random.default_rng(942)
    boot = pt[rng.integers(0, len(pt), size=(1500, len(pt)))].sum(axis=1)
    ci = lambda x: [float(v) for v in np.percentile(x, [2.5, 97.5])]
    return {
        "window_AUROC": float(roc_auc_score(y, p)),
        "window_average_precision": float(average_precision_score(y, p)),
        "window_seizure_prevalence": float(y.mean()),
        "window_Brier": float(brier_score_loss(y, p)),
        "scored_windows": int(good),
        "coverage_known_windows": float(good / total),
        "majority_seizures_at_least_10s": int(e),
        "events_with_alarm_start": int(h),
        "event_sensitivity": float(h / e),
        "event_sensitivity_patient_bootstrap_95": ci(boot[:, 0] / np.maximum(boot[:, 1], 1)),
        "false_alarm_starts": int(f),
        "background_hours": float(s / 3600),
        "false_alarm_starts_per_background_hour": float(f * 3600 / s),
        "false_alarms_per_hour_patient_bootstrap_95": ci(boot[:, 2] * 3600 / boot[:, 3]),
        "background_fraction_alarm_active": float(o / s),
        "median_latency_seconds_detected": float(np.median(delays)) if delays else None,
        "window_sensitivity_at_threshold": float(tp / pos),
        "window_specificity_at_threshold": float(tn / neg),
    }


def main(root, out):
    files = [root / f"{i}.npz" for i in range(1, 80)]
    if not all(f.exists() for f in files):
        raise RuntimeError("requires all 79 records")
    out.mkdir(parents=True, exist_ok=True)
    result = {}
    for montage in ("frontal", "broader"):
        cases = [case(f, montage) for f in files]
        strata = [bool(r["events"]) for r in cases]
        folds = [
            test
            for _, test in StratifiedKFold(5, shuffle=True, random_state=941).split(files, strata)
        ]
        result[montage] = {}
        for kind in ("linear", "boosted"):
            scores = [None] * len(files)
            thresholds = np.zeros(len(files))
            operating = []
            for k in range(5):
                test = folds[k]
                cal = folds[(k + 1) % 5]
                train_ids = sorted(set(range(len(files))) - set(test) - set(cal))
                model = train(cases, train_ids, kind)
                pc = {i: raw_scores(model, cases[i]) for i in cal}
                recal = calibrate(cases, cal, pc)
                pc = {i: apply_calibration(recal, p) for i, p in pc.items()}
                t = operating_point(cases, cal, pc)
                operating.append(t)
                for i in test:
                    scores[i] = apply_calibration(recal, raw_scores(model, cases[i]))
                    thresholds[i] = t
            result[montage][kind] = {
                **pooled(cases, scores, thresholds),
                "calibration_thresholds": operating,
            }
            print(montage, kind, result[montage][kind]["event_sensitivity"], flush=True)
        # Reusable fixed boosted research fit, with a dedicated calibration partition.
        cal = folds[0]
        train_ids = sorted(set(range(len(files))) - set(cal))
        model = train(cases, train_ids, "boosted")
        p = {i: raw_scores(model, cases[i]) for i in cal}
        recal = calibrate(cases, cal, p)
        p = {i: apply_calibration(recal, v) for i, v in p.items()}
        threshold = operating_point(cases, cal, p)
        joblib.dump(
            {
                "model": model,
                "calibration": recal,
                "threshold": threshold,
                "montage": montage,
                "pairs": PAIRS[: 2 if montage == "frontal" else 8],
                "measures": MEASURES,
                "window_seconds": SECONDS,
                "train_n": len(train_ids),
                "calibration_n": len(cal),
                "seed": 941,
            },
            out / f"neonatal-{montage}.joblib",
            compress=3,
        )
    votes = np.concatenate([r["votes"] for r in cases])
    known = votes >= 0
    result["cohort"] = {
        "neonates": len(files),
        "recording_hours_windowed": len(votes) / 3600,
        "known_expert_hours": float(known.sum() / 3600),
        "nonunanimous_fraction_known_seconds": float(np.isin(votes[known], [1, 2]).mean()),
        "patients_with_majority_events_10s": int(sum(strata)),
        "outer_folds": 5,
    }
    (out / "neonatal-results.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
