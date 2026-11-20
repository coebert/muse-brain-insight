#!/usr/bin/env python3
"""Train offline EEG research baselines on attributed public datasets."""
import argparse
import concurrent.futures
import hashlib
import io
import json
import math
import re
import urllib.parse
import zipfile
from pathlib import Path

import h5py
import numpy as np
import pyedflib
import requests
from scipy import io as scipy_io
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import average_precision_score, mean_absolute_error, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

PHYSIO = "https://physionet-open.s3.amazonaws.com/"
FIGSHARE = "https://api.figshare.com/v2/articles/5589841"
FEATURES = ["log_rms", "log_line_length", "delta", "theta", "alpha", "beta", "gamma", "sef95", "entropy"]
SEIZURE_CHANNELS = ("FP1-F7", "FP2-F8")
ALIAS = {"T3": "T7", "T4": "T8", "T5": "P7", "T6": "P8"}


def get(url):
    for attempt in range(3):
        try:
            response = requests.get(url, timeout=(20, 110))
            response.raise_for_status()
            return response
        except requests.RequestException:
            if attempt == 2:
                raise


def normalise(name):
    name = re.sub(r"^EEG\s+", "", name.upper().strip()).removesuffix("-REF")
    return "-".join(ALIAS.get(part, part) for part in name.split("-"))


def feature(x, hz):
    x = np.asarray(x, dtype=np.float64)
    if not np.isfinite(x).all() or x.size < 4 * hz:
        return None
    x = x - np.mean(x)
    rms = np.sqrt(np.mean(x * x))
    if rms <= 1e-8:
        return None
    p = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    freq = np.fft.rfftfreq(len(x), 1 / hz)
    mask = (freq >= 0.5) & (freq < 45)
    total = p[mask].sum()
    if not total > 0:
        return None
    values = [np.log1p(rms), np.log1p(np.mean(np.abs(np.diff(x))) * hz)]
    for lo, hi in [(0.5, 4), (4, 8), (8, 13), (13, 30), (30, 45)]:
        values.append(p[(freq >= lo) & (freq < hi)].sum() / total)
    prob = p[mask] / total
    values.append(freq[mask][min(np.searchsorted(np.cumsum(prob), 0.95), len(prob) - 1)])
    positive = prob[prob > 0]
    values.append(-np.sum(positive * np.log(positive)) / np.log(len(prob)))
    return values


def chb_annotations(summary):
    results = {}
    for match in re.split(r"File Name:\s*", summary, flags=re.I)[1:]:
        name = match.splitlines()[0].strip()
        starts = re.findall(r"Seizure(?:\s+\d+)?\s+Start Time:\s*(\d+)", match, re.I)
        ends = re.findall(r"Seizure(?:\s+\d+)?\s+End Time:\s*(\d+)", match, re.I)
        count = re.search(r"Number of Seizures in File:\s*(\d+)", match, re.I)
        if count and int(count[1]) == len(starts) == len(ends):
            results[name] = [(int(a), int(b)) for a, b in zip(starts, ends) if int(a) < int(b)]
    return results


def clock(value):
    h, m, s = map(int, re.findall(r"\d+", value))
    return h * 3600 + m * 60 + s


def siena_annotations(summary):
    results = {}
    for segment in re.split(r"Seizure\s+n(?:o\.?|\.)?\s*\d+", summary, flags=re.I)[1:]:
        name = re.search(r"File name:\s*(\S+\.edf)", segment, re.I)
        fields = [
            re.search(rf"{key}\s*:\s*(\d{{1,2}}[.:]\d{{2}}[.:]\d{{2}})", segment, re.I)
            for key in ("Registration start time", "Seizure start time", "Seizure end time")
        ]
        if name and all(fields):
            origin, start, end = [clock(x[1]) for x in fields]
            a, b = (start - origin) % 86400, (end - origin) % 86400
            if a < b:
                results.setdefault(name[1], []).append((a, b))
    return results


def montage(reader, dataset):
    names = [normalise(x) for x in reader.getSignalLabels()]
    signals = []
    for pair in SEIZURE_CHANNELS:
        if pair in names and names.count(pair) == 1:
            i = names.index(pair)
            signals.append((reader.getSampleFrequency(i), reader.readSignal(i)))
            continue
        a, b = pair.split("-")
        if dataset != "siena" or names.count(a) != 1 or names.count(b) != 1:
            raise ValueError("required frontal derivations unavailable")
        i, j = names.index(a), names.index(b)
        hz = reader.getSampleFrequency(i)
        if hz != reader.getSampleFrequency(j):
            raise ValueError("referential channels disagree on sample rate")
        units = [reader.getPhysicalDimension(k).strip().lower().replace("µ", "u") for k in (i, j)]
        if units != ["uv", "uv"]:
            raise ValueError("expected microvolt referential data")
        signals.append((hz, reader.readSignal(i) - reader.readSignal(j)))
    return signals


def subject(spec, data):
    dataset, key, annotations = spec
    folder = data / dataset / key
    folder.mkdir(parents=True, exist_ok=True)
    base = PHYSIO + ("chbmit" if dataset == "chb" else "siena-scalp-eeg") + "/1.0.0/" + key + "/"
    summary_name = key + "-summary.txt" if dataset == "chb" else "Seizures-list-" + key + ".txt"
    summary = get(base + summary_name).text
    entries = annotations(summary)
    sample = [(name, periods) for name, periods in entries.items() if periods][:2]
    sample += [(name, periods) for name, periods in entries.items() if not periods][:1]
    rows = []
    files = []
    notes = []
    for name, periods in sample:
        path = folder / name
        if not path.exists():
            path.write_bytes(get(base + urllib.parse.quote(name)).content)
        try:
            with pyedflib.EdfReader(str(path)) as reader:
                signals = montage(reader, dataset)
                length = int(reader.getFileDuration())
        except (OSError, ValueError) as error:
            notes.append({"file": name, "reason": str(error)})
            path.unlink(missing_ok=True)
            continue
        valid = [(a, b) for a, b in periods if 0 <= a < b <= length]
        if len(valid) != len(periods):
            notes.append({"file": name, "reason": "event outside EDF duration, excluded recording"})
            path.unlink(missing_ok=True)
            continue
        for start in range(0, length - 3, 4):
            end = start + 4
            positive = any(a <= start and end <= b for a, b in valid)
            if not positive and any(start < b + 60 and end > a - 60 for a, b in valid):
                continue
            feats = []
            for hz, signal in signals:
                current = feature(signal[round(start * hz):round(end * hz)], hz)
                if current is None:
                    break
                feats.extend(current)
            if len(feats) == 2 * len(FEATURES):
                rows.append((key, dataset, int(positive), feats))
        files.append({"name": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                      "stop_seconds": length, "eligible_intervals": len(valid)})
        path.unlink(missing_ok=True)
    return rows, {"subject": key, "cohort": dataset, "files": files, "excluded_files": notes}


def model_json(model):
    scaler, predictor = model.steps[0][1], model.steps[1][1]
    return {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
            "coef": np.ravel(predictor.coef_).tolist(),
            "intercept": float(np.ravel(predictor.intercept_)[0])}


def seizure_metrics(rows, pred, threshold):
    y = np.array([r[2] for r in rows])
    p = pred >= threshold
    positive, negative = y == 1, y == 0
    return {"patients": len({r[0] for r in rows}), "positive_windows": int(positive.sum()),
            "negative_windows": int(negative.sum()), "roc_auc": float(roc_auc_score(y, pred)) if len(set(y)) == 2 else None,
            "average_precision": float(average_precision_score(y, pred)) if positive.any() else None,
            "window_sensitivity": float(p[positive].mean()) if positive.any() else None,
            "positive_negative_windows_per_hour": float(p[negative].mean() * 900) if negative.any() else None}


def train_seizures(data, output):
    specs = [
        *[("chb", f"chb{i:02d}", chb_annotations) for i in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16)],
        *[("siena", f"PN{i:02d}", siena_annotations) for i in (0, 1, 3, 5, 6, 9, 10, 11, 12, 13, 14, 16, 17)],
    ]  # CHB-21 is a later recording from the CHB-01 patient and is omitted.
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        pending = {pool.submit(subject, spec, data): spec for spec in specs}
        rows, manifest, errors = [], [], []
        for future in concurrent.futures.as_completed(pending):
            dataset, key, _ = pending[future]
            try:
                found, info = future.result()
                rows.extend(found)
                manifest.append(info)
                print(f"{dataset}/{key}: {len(found)} eligible windows", flush=True)
            except (requests.RequestException, OSError, ValueError) as error:
                errors.append({"cohort": dataset, "subject": key, "reason": str(error)})
                print(f"{dataset}/{key} excluded: {error}", flush=True)
    rows.sort(key=lambda r: (r[1], r[0]))
    split = {"train": [], "calibration": [], "test": []}
    for dataset in ("chb", "siena"):
        keys = sorted({row[0] for row in rows if row[1] == dataset and row[2]},
                      key=lambda key: hashlib.sha256(("mindguard-benchmark-v1/" + key).encode()).hexdigest())
        if len(keys) < 6:
            raise ValueError(f"{dataset}: only {len(keys)} patients with verified positive windows; errors={errors}")
        held_out = max(2, len(keys) // 4)
        for stage, subjects in (("test", keys[:held_out]), ("calibration", keys[held_out:held_out+2]),
                                ("train", keys[held_out+2:])):
            split[stage].extend(r for r in rows if r[1] == dataset and r[0] in subjects)
    train, cal, test = (split[k] for k in ("train", "calibration", "test"))
    fit = make_pipeline(StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=500))
    fit.fit([r[3] for r in train], [r[2] for r in train])
    cal_p = fit.predict_proba([r[3] for r in cal])[:, 1]
    thresholds = np.append(np.unique(cal_p), np.inf)
    negatives = cal_p[np.array([r[2] for r in cal]) == 0]
    threshold = next(float(t) for t in thresholds if np.mean(negatives >= t) <= 0.01)
    if not np.isfinite(threshold):
        raise ValueError("calibration could not yield a finite threshold")
    report = {"task": "seizure_window", "model_status": "research_only", "window_seconds": 4,
              "montage": SEIZURE_CHANNELS, "cohort_licenses": {"chb": "ODC-BY-1.0", "siena": "CC-BY-4.0"},
              "split_patients": {k: sorted({r[0] for r in value}) for k, value in split.items()},
              "threshold": threshold,
              "metrics": {cohort: seizure_metrics(group, fit.predict_proba([r[3] for r in group])[:, 1], threshold)
                          for cohort in ("pooled", "chb", "siena")
                          if (group := [r for r in test if cohort == "pooled" or r[1] == cohort])},
              "recordings": sorted(manifest, key=lambda m: m["subject"]), "excluded_subjects": errors,
              "feature_names": [c + ":" + f for c in SEIZURE_CHANNELS for f in FEATURES], "weights": model_json(fit)}
    (output / "seizure-window.json").write_text(json.dumps(report, indent=2, allow_nan=False))


def mat_pairs(payload):
    try:
        with h5py.File(io.BytesIO(payload)) as mat:
            arrays = {key.lower(): np.asarray(value).ravel() for key, value in mat.items()
                      if isinstance(value, h5py.Dataset) and value.dtype.kind in "fiu"}
    except OSError:
        arrays = {key.lower(): np.asarray(value).ravel() for key, value in scipy_io.loadmat(io.BytesIO(payload)).items()
                  if not key.startswith("__") and np.asarray(value).dtype.kind in "fiu"}
    eegs = [(k, a) for k, a in arrays.items() if "eeg" in k]
    indices = [(k, a) for k, a in arrays.items() if "bis" in k]
    pairs = [(eeg, bis) for _, eeg in eegs for _, bis in indices
             if len(bis) >= 40 and 593.75 <= len(eeg) / len(bis) <= 656.25]
    if len(pairs) != 1:
        raise ValueError("missing or ambiguous EEG and BIS vectors or unexpected ratio: " +
                         str({key: len(value) for key, value in arrays.items()}))
    return pairs[0]


def train_bis(output):
    api = get(FIGSHARE).json()
    if "CC BY" not in api["license"]["name"].upper():
        raise ValueError("unexpected Figshare licence")
    cases = []
    for f in api["files"]:
        raw = get(f["downloadUrl"]).content
        if f.get("computed_md5") and hashlib.md5(raw).hexdigest() != f["computed_md5"]:
            raise ValueError(f"checksum mismatch: {f['name']}")
        if f["name"].lower().endswith(".mat"):
            cases.append((f["name"], raw))
        elif f["name"].lower().endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                cases.extend((name, z.read(name)) for name in z.namelist()
                             if name.lower().endswith(".mat") and not name.startswith("__MACOSX"))
    matrices, excluded = [], []
    seen = set()
    for name, payload in cases:
        digest = hashlib.sha256(payload).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        try:
            eeg, bis = mat_pairs(payload)
        except ValueError as error:
            excluded.append({"file": name, "reason": str(error)})
            continue
        rows = []
        for i in range(1, len(bis)):
            endpoint = i * 625
            if not 1 <= bis[i] <= 100 or endpoint > len(eeg):
                continue
            x = feature(eeg[endpoint - 625:endpoint], 125)
            if x is not None:
                rows.append((x, float(bis[i])))
        if rows:
            matrices.append((digest, name, rows))
    matrices.sort(key=lambda item: item[0])
    if len(matrices) < 8:
        raise ValueError(f"only {len(matrices)} usable surgical cases: {excluded}")
    n_test = max(3, len(matrices) // 4)
    test, train = matrices[:n_test], matrices[n_test:]
    training = [row for _, _, rows in train for row in rows]
    x, y = zip(*training)
    model = make_pipeline(StandardScaler(), Ridge(alpha=10))
    model.fit(x, y)
    median = float(np.median(y))
    scores = []
    for digest, name, rows in test:
        x_test, y_test = zip(*rows)
        pred = np.clip(model.predict(x_test), 0, 100)
        scores.append({"file": name, "sha256": digest, "windows": len(rows),
                       "mae": float(mean_absolute_error(y_test, pred)),
                       "median_baseline_mae": float(mean_absolute_error(y_test, np.full(len(rows), median)))})
    report = {"task": "bis_agreement_only", "model_status": "research_only", "article": api["url_public_html"],
              "licence": api["license"]["name"], "assumed_sample_hz": 125, "assumed_BIS_cadence_seconds": 5,
              "training_cases": len(train), "training_windows": len(training),
              "held_out_cases": len(test), "held_out_case_results": scores, "excluded": excluded,
              "case_mean_mae": float(np.mean([s["mae"] for s in scores])),
              "case_mean_constant_baseline_mae": float(np.mean([s["median_baseline_mae"] for s in scores])),
              "feature_names": FEATURES, "weights": model_json(model)}
    (output / "bis-agreement.json").write_text(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("task", choices=("seizures", "bis"))
    parser.add_argument("--data", type=Path, default=Path("research-cache"))
    parser.add_argument("--output", type=Path, default=Path("research-results"))
    options = parser.parse_args()
    options.output.mkdir(parents=True, exist_ok=True)
    if options.task == "seizures":
        train_seizures(options.data, options.output)
    else:
        train_bis(options.output)
