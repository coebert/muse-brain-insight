"""Causal neonatal EEG history and an explicitly conditional three-reader agreement test."""

from pathlib import Path
import sys, json
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold
from fit_seizures import (
    case,
    train,
    raw_scores,
    calibrate,
    apply_calibration,
    operating_point,
    pooled,
    alarm_counts,
)
from waveforms import MEASURES


def add_history(r):
    x = r["x"]
    # Summarise amplitude, rhythm and irregularity at bilateral extrema in every region.
    js = [
        j
        for j in range(x.shape[1])
        if MEASURES[j % len(MEASURES)] in ("log_rms", "delta", "alpha", "entropy", "edge95")
    ]
    select = x[:, js]
    v = r["usable"]
    extra = np.zeros((len(x), len(js) * 2 + 1), dtype="float32")
    start = 0
    for t in range(len(x)):
        if not v[t]:
            start = t + 1
            continue
        past = select[max(start, t - 8) : t]
        if len(past):
            extra[t, : len(js)] = select[t] - np.mean(past[-3:], axis=0)
            extra[t, len(js) : 2 * len(js)] = select[t] - np.mean(past, axis=0)
        extra[t, -1] = len(past) / 8
    return {**r, "x": np.c_[x, extra]}


def test_readers(root, cases, probabilities, thresholds):
    ann = [pd.read_csv(root / (c + ".csv")) for c in "ABC"]
    res = []
    for h in range(3):
        nums = np.zeros(8, dtype=int)
        for k, (r, p, t) in enumerate(zip(cases, probabilities, thresholds)):
            n = len(p)
            a = np.stack([z[str(k + 1)].to_numpy()[: 8 * n].reshape(n, 8) for z in ann])
            i, j = [v for v in range(3) if v != h]
            pos = ((a[i] == 1) & (a[j] == 1)).all(axis=1)
            neg = ((a[i] == 0) & (a[j] == 0)).all(axis=1)
            good = np.isfinite(p) & np.isin(a[h], [0, 1]).all(axis=1) & (pos | neg)
            truth = pos[good]
            reader = a[h, good].mean(axis=1) >= 0.5
            model = p[good] >= t
            nums += np.array(
                [
                    truth.sum(),
                    (~truth).sum(),
                    sum(reader & truth),
                    sum(~reader & ~truth),
                    sum(model & truth),
                    sum(~model & ~truth),
                    sum((model == truth) & (reader != truth)),
                    sum((reader == truth) & (model != truth)),
                ]
            )
        pos, neg, ht, hn, mt, mn, model_only, reader_only = map(int, nums)
        res.append(
            dict(
                reference_positive=pos,
                reference_negative=neg,
                reader_sensitivity=ht / pos,
                reader_specificity=hn / neg,
                model_sensitivity=mt / pos,
                model_specificity=mn / neg,
                model_alone_agrees_with_reference=model_only,
                reader_alone_agrees_with_reference=reader_only,
            )
        )
    return res


def run(root, out):
    files = [root / f"{i}.npz" for i in range(1, 80)]
    original = [case(f, "broader") for f in files]
    folds = [
        b
        for _, b in StratifiedKFold(5, shuffle=True, random_state=941).split(
            files, [bool(r["events"]) for r in original]
        )
    ]
    report = {}
    by = {}
    for name, cases in [
        ("current_window", original),
        ("past_and_current", [add_history(r) for r in original]),
    ]:
        preds = [None] * 79
        thresholds = np.zeros(79)
        for k, test in enumerate(folds):
            cal = folds[(k + 1) % 5]
            tr = sorted(set(range(79)) - set(test) - set(cal))
            model = train(cases, tr, "linear")
            pc = {i: raw_scores(model, cases[i]) for i in cal}
            recal = calibrate(cases, cal, pc)
            pc = {i: apply_calibration(recal, p) for i, p in pc.items()}
            t = operating_point(cases, cal, pc)
            for i in test:
                preds[i] = apply_calibration(recal, raw_scores(model, cases[i]))
                thresholds[i] = t
        report[name] = pooled(cases, preds, thresholds)
        by[name] = np.stack(
            [alarm_counts(r, p, t)[0] for r, p, t in zip(cases, preds, thresholds)]
        )
        if name == "past_and_current":
            report["reader_comparisons"] = test_readers(root, cases, preds, thresholds)
        print(name, report[name]["events_with_alarm_start"], flush=True)
    rng = np.random.default_rng(1704)
    ix = rng.integers(0, 79, (3000, 79))
    a, b = [by[k][ix].sum(axis=1) for k in ["current_window", "past_and_current"]]
    report["paired_interval"] = {
        "event_sensitivity_change": np.quantile(
            (b[:, 0] - a[:, 0]) / a[:, 1], [0.025, 0.975]
        ).tolist(),
        "false_starts_per_hour_change": np.quantile(
            3600 * (b[:, 2] - a[:, 2]) / a[:, 3], [0.025, 0.975]
        ).tolist(),
    }
    out.mkdir(exist_ok=True, parents=True)
    (out / "neonatal-history-results.json").write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n"
    )


if __name__ == "__main__":
    run(Path(sys.argv[1]), Path(sys.argv[2]))
