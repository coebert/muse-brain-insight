"""Research-only rocuronium pump/EEG alignment and cross-case EMG regression."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import argparse
import hashlib
import io
import json
import time
import numpy as np
import pandas as pd
import requests
from scipy.signal import welch
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline

API = "https://api.vitaldb.net/"
TRACKS = [
    "Orchestra/ROC_RATE",
    "Orchestra/ROC_VOL",
    "BIS/EEG1_WAV",
    "BIS/EEG2_WAV",
    "BIS/EMG",
    "BIS/SQI",
]
FS = 128
BANDS = [(0.5, 4), (4, 8), (8, 13), (13, 20), (20, 30), (30, 42), (42, 55)]


def numeric(tid):
    for attempt in range(3):
        try:
            r = requests.get(API + tid, timeout=(15, 60))
            r.raise_for_status()
            a = pd.read_csv(io.BytesIO(r.content)).dropna().to_numpy(dtype=float)
            return a[np.argsort(a[:, 0], kind="stable")]
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def interval(arr, lo, hi):
    return arr[(arr[:, 0] >= lo) & (arr[:, 0] < hi)]


def pump_transition(a):
    # The first sustained increase from zero or a minimal carrier rate.
    idx = np.flatnonzero((a[:-1, 1] <= 0.2) & (a[1:, 1] >= 1)) + 1
    for i in idx:
        t = a[i, 0]
        pre = interval(a, t - 120, t)
        post = interval(a, t, t + 30)
        if (
            len(pre) >= 8
            and len(post) >= 4
            and pre[0, 0] <= t - 100
            and post[-1, 0] >= t + 20
            and np.max(np.diff(np.r_[pre[:, 0], post[:, 0]])) <= 20
            and np.all(pre[:, 1] <= 0.2)
            and np.all(post[:, 1] >= 1)
        ):
            return float(t)
    return None


def waveform(tid, lo, hi):
    n = int(round((hi - lo) * FS))
    result = np.full(n, np.nan)
    with requests.get(API + tid, stream=True, timeout=(15, 90)) as r:
        r.raise_for_status()
        r.raw.decode_content = True
        last = np.nan
        for chunk in pd.read_csv(r.raw, chunksize=65536):
            ts, values = chunk.to_numpy(float).T
            idx = np.arange(len(ts))
            anchors = np.where(np.isfinite(ts), ts - idx / FS, np.nan)
            if not np.isfinite(anchors[0]):
                anchors[0] = last
            times = pd.Series(anchors).ffill().to_numpy() + idx / FS
            last = times[-1] + 1 / FS
            keep = (times >= lo) & (times < hi)
            pos = np.rint((times[keep] - lo) * FS).astype(int)
            valid = (pos >= 0) & (pos < n)
            result[pos[valid]] = values[keep][valid]
            if np.any(times > hi + 1):
                break
    return result


def windows(case, tracks, event):
    lo = np.floor(event * FS) / FS - 96
    hi = lo + 288
    emg = numeric(tracks["BIS/EMG"])
    sq = numeric(tracks["BIS/SQI"])
    volume = numeric(tracks["Orchestra/ROC_VOL"])
    local = interval(volume, event - 10, event + 150)
    if (
        len(local) < 2
        or local[0, 0] > event + 2
        or local[-1, 0] < event + 100
        or np.any(np.diff(local[:, 1]) < -0.001)
        or local[-1, 1] <= local[0, 1]
    ):
        return [], "no_confirming_pump_volume"
    channels = np.stack([waveform(tracks[k], lo, hi) for k in TRACKS[2:4]])
    rows = []
    for s in range(0, 288, 8):
        t = lo + s
        val = interval(emg, t, t + 8)
        quality = interval(sq, t, t + 8)
        if len(val) < 4 or len(quality) < 4 or np.min(quality[:, 1]) < 80:
            continue
        x = channels[:, s * FS : (s + 8) * FS]
        if (
            not np.isfinite(x).all()
            or np.any(np.ptp(x, axis=1) < 1)
            or np.any(np.ptp(x, axis=1) > 1200)
        ):
            continue
        f, p = welch(x, fs=FS, nperseg=2 * FS, axis=1)
        powers = [
            float(
                np.median(
                    np.log10(np.maximum(p[:, (f >= a) & (f < b)].sum(axis=1) * 0.5, 1e-12))
                )
            )
            for a, b in BANDS
        ]
        d = float(np.median(val[:, 1]))
        if not 0 <= d <= 100:
            continue
        rows.append([case, s - 96, d, *powers])
    return rows, "ok" if rows else "insufficient_clean_EEG"


def assess(rows):
    a = np.array(rows)
    g = a[:, 0]
    y = a[:, 2]
    x = a[:, 3:]
    guess = np.empty(len(y))
    baseline = np.empty(len(y))
    for tr, te in GroupKFold(min(5, len(np.unique(g)))).split(x, y, g):
        weights = np.array([1 / np.sum(g[tr] == i) for i in g[tr]])
        weights *= len(tr) / weights.sum()
        pipe = make_pipeline(StandardScaler(), Ridge(alpha=12))
        pipe.fit(
            x[tr], y[tr], standardscaler__sample_weight=weights, ridge__sample_weight=weights
        )
        guess[te] = pipe.predict(x[te])
        baseline[te] = np.mean([np.mean(y[tr][g[tr] == i]) for i in set(g[tr])])
    cases = np.unique(g)

    def per_case(v):
        return np.array([np.mean(v[g == i]) for i in cases])

    changes = []
    for i in cases:
        one = a[g == i]
        pre = one[(one[:, 1] >= -96) & (one[:, 1] < -16)]
        post = one[(one[:, 1] >= 64) & (one[:, 1] < 176)]
        if min(len(pre), len(post)) >= 4:
            diff = np.median(post, axis=0) - np.median(pre, axis=0)
            changes.append([diff[2], diff[9], diff[5]])

    def describe(a):
        return {"median": float(np.median(a)), "IQR": np.quantile(a, [0.25, 0.75]).tolist()}

    diff = per_case(abs(baseline - y)) - per_case(abs(guess - y))
    rng = np.random.default_rng(684)
    weights = np.array([1 / np.sum(g == i) for i in g])
    weights *= len(g) / weights.sum()
    sc = StandardScaler().fit(x, sample_weight=weights)
    reg = Ridge(alpha=12).fit(sc.transform(x), y, sample_weight=weights)
    model = {
        "feature_log10_uV2": BANDS,
        "sampling_hz": 128,
        "window_s": 8,
        "mean": sc.mean_.tolist(),
        "scale": sc.scale_.tolist(),
        "coef": reg.coef_.tolist(),
        "intercept": float(reg.intercept_),
        "endpoint": "device EMG in dB only",
        "context": "VitalDB BIS montage, filtered surgical research windows",
    }
    assert np.allclose(
        reg.predict(sc.transform(x)), ((x - sc.mean_) / sc.scale_) @ reg.coef_ + reg.intercept_
    )
    return {
        "cases": len(cases),
        "valid_windows": len(y),
        "case_mean_MAE_EMG_dB": float(np.mean(per_case(abs(guess - y)))),
        "case_mean_baseline_MAE_dB": float(np.mean(per_case(abs(baseline - y)))),
        "paired_MAE_gain_ci": np.quantile(
            rng.choice(diff, (2000, len(diff)), replace=True).mean(axis=1), [0.025, 0.975]
        ).tolist(),
        "pre_post_cases": len(changes),
        "post_minus_pre": (
            dict(
                zip(
                    ["EMG_dB", "42_to_55_log10_power", "alpha_log10_power"],
                    [describe(q) for q in np.array(changes).T],
                )
            )
            if changes
            else {}
        ),
    }, model


def main(root, limit):
    import collections

    cache = root / "cache-rocuronium"
    cache.mkdir(exist_ok=True)
    tpath = root / "vitaltracks.csv"
    if not tpath.exists():
        r = requests.get(API + "trks", timeout=120)
        r.raise_for_status()
        tpath.write_bytes(r.content)
    t = pd.read_csv(tpath)
    subset = t[t.tname.isin(TRACKS)]
    matched = [
        (int(c), dict(zip(v.tname, v.tid)))
        for c, v in subset.groupby("caseid")
        if set(v.tname) == set(TRACKS)
    ]
    unique = [
        (c, tracks) for c, tracks in matched if len(subset[subset.caseid == c]) == len(TRACKS)
    ]

    def screen(item):
        c, tracks = item
        path = cache / f"pump-{c}.json"
        if not path.exists():
            path.write_text(json.dumps(pump_transition(numeric(tracks[TRACKS[0]]))))
        return c, tracks, json.loads(path.read_text())

    with ThreadPoolExecutor(9) as p:
        screened = list(p.map(screen, unique))
    candidates = [r for r in screened if r[2] is not None]
    candidates.sort(key=lambda r: hashlib.sha256(f"roc-research-1/{r[0]}".encode()).hexdigest())
    print("screened", len(screened), "candidate", len(candidates), flush=True)

    def extract(item):
        c, tracks, event = item
        path = cache / f"eeg-{c}.json"
        if not path.exists():
            for attempt in range(3):
                try:
                    value = windows(c, tracks, event)
                    path.write_text(json.dumps(value))
                    break
                except (requests.RequestException, OSError) as e:
                    if attempt == 2:
                        raise
        value = json.loads(path.read_text())
        print(c, value[1], len(value[0]), flush=True)
        return value

    with ThreadPoolExecutor(6) as p:
        observed = list(p.map(extract, candidates[:limit]))
    rows = [r for x, _ in observed for r in x]
    summary = {
        "track_intersection": len(matched),
        "unique_tracks": len(unique),
        "timed_pump_transitions": len(candidates),
        "attempted_EEG": len(observed),
        "retention": dict(collections.Counter(k for _, k in observed)),
        "selection": "First sustained rise from <=0.2 to >=1 mL/h with a low-rate run-in; ascending fixed-seed SHA-256 of case ID; volume confirmation and signal quality >=80 required.",
    }
    out = root / "results"
    if rows and len(set(r[0] for r in rows)) >= 5:
        metrics, model = assess(rows)
        summary.update(metrics)
        (out / "rocuronium-emg-weights.json").write_text(json.dumps(model, indent=2))
    (out / "rocuronium-surgical-results.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--limit", type=int, default=60)
    a = parser.parse_args()
    main(a.root, a.limit)
