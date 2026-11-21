#!/usr/bin/env python3
"""Waveform discovery and independent cohort checks for offline EEG research."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile

import numpy as np
import pandas as pd
import requests
from scipy import io as matio, signal, stats
from scipy.special import entr
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC


RELEASES = {"ds004504": "1.0.9", "ds003490": "1.1.0", "ds007526": "1.0.2"}
S3 = "https://s3.amazonaws.com/openneuro.org"
FIGSHARE = "https://api.figshare.com/v2/articles/5450293/versions/1"
ELECTRODES = (
    "FP1", "FP2", "F7", "F8", "F3", "F4", "C3", "C4",
    "P3", "P4", "O1", "O2", "T7", "T8", "P7", "P8", "FZ", "CZ", "PZ",
)
ALIAS = {"T3": "T7", "T4": "T8", "T5": "P7", "T6": "P8"}
MONTAGE = {"frontal": ("FP1", "F7", "FP2", "F8"),
           "central": ("F3", "C3", "F4", "C4"),
           "posterior": ("P3", "O1", "P4", "O2")}
BANDS = {"delta": (1, 4), "theta": (4, 8), "alpha": (8, 13), "beta": (13, 30)}
SIMPLE = ("delta", "theta", "alpha", "beta", "slowing")
RNG_SEED = 20261121
MIN_WINDOWS = 5


def download(url, dest):
    if dest.exists() and dest.stat().st_size:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".partial")
    for attempt in range(3):
        try:
            with requests.get(url, timeout=(12, 70), stream=True) as response:
                response.raise_for_status()
                with part.open("wb") as writer:
                    for chunk in response.iter_content(256 * 1024):
                        writer.write(chunk)
            part.replace(dest)
            return dest
        except requests.RequestException:
            if attempt == 2:
                raise
    raise AssertionError("unreachable")


def digest(path, kind="sha256"):
    with path.open("rb") as f:
        return hashlib.file_digest(f, kind).hexdigest()


def repo_asset(dataset, rel, cache, is_wave=False):
    root = f"https://raw.githubusercontent.com/OpenNeuroDatasets/{dataset}/{RELEASES[dataset]}"
    dest = cache / dataset / rel
    if not is_wave:
        return download(f"{root}/{rel}", dest)
    pointer = download(f"{root}/{rel}", cache / dataset / "_pointers" / rel)
    if pointer.stat().st_size > 4096:
        return pointer
    ref = pointer.read_text(errors="ignore")
    key = re.search(r"SHA256E?-s(\d+)--([a-f0-9]{64})", ref)
    lfs = re.search(r"oid sha256:([a-f0-9]{64})\s+size (\d+)", ref)
    if key is not None:
        size, checksum = int(key[1]), key[2]
    elif lfs is not None:
        size, checksum = int(lfs[2]), lfs[1]
    else:
        # Older OpenNeuro releases used an MD5 annex key.
        md5 = re.search(r"MD5E?-s(\d+)--([a-f0-9]{32})", ref)
        if md5 is None:
            raise ValueError("unrecognised pinned annex key")
        size, checksum = int(md5[1]), md5[2]
    for host in (f"{S3}/{dataset}", f"https://openneuro.org/crn/datasets/{dataset}/snapshots/{RELEASES[dataset]}/files"):
        url = f"{host}/{rel}" if host.startswith(S3) else f"{host}/{rel.replace('/', ':')}"
        try:
            wave = download(url, dest)
            if wave.stat().st_size == size and digest(wave, "sha256" if len(checksum) == 64 else "md5") == checksum:
                return wave
        except requests.RequestException:
            continue
        dest.unlink(missing_ok=True)
    raise ValueError("waveform not verified against pinned archive key")


def canonical(name):
    name = re.sub(r"^EEG\s+", "", str(name).strip().upper()).removesuffix("-REF")
    return ALIAS.get(name, name)


def bipolar(samples, names):
    names = [canonical(x) for x in names]
    derivations = []
    for electrodes in MONTAGE.values():
        for a, b in zip(electrodes[::2], electrodes[1::2]):
            if names.count(a) != 1 or names.count(b) != 1:
                raise ValueError("required montage channel missing or ambiguous")
            derivations.append(samples[names.index(a)] - samples[names.index(b)])
    return np.asarray(derivations, dtype=np.float64)


def ordinal_entropy(x):
    patterns = np.argsort(np.stack([x[:, :, i : x.shape[-1] - 8 + i] for i in (0, 4, 8)], axis=-1), axis=-1)
    symbols = patterns @ [9, 3, 1]
    counts = np.stack([(symbols == k).mean(axis=-1) for k in (5, 7, 11, 15, 19, 21)], axis=-1)
    return entr(counts).sum(axis=-1) / np.log(6)


def extract(samples, hz, seconds=48):
    if not 110 <= hz <= 2048 or samples.shape[0] != 6:
        raise ValueError("incompatible sample rate or montage")
    samples = samples[:, :int(seconds * hz)]
    if samples.shape[1] < MIN_WINDOWS * 4 * int(hz):
        raise ValueError("insufficient waveform")
    # Fixed window duration. No continuous filter or interpolation across gaps.
    width = int(round(4 * hz))
    count = samples.shape[1] // width
    epochs = samples[:, :count * width].reshape(6, count, width).transpose(1, 0, 2)
    epochs = epochs[np.isfinite(epochs).all(axis=(1, 2))]
    spread = np.ptp(epochs, axis=-1)
    typical = np.median(spread, axis=0)
    keep = ((spread > 0) & (spread <= 5 * typical)).all(axis=1)
    epochs = epochs[keep]
    if len(epochs) < MIN_WINDOWS:
        raise ValueError("insufficient finite, nonflat, low-amplitude-outlier windows")
    epochs = signal.detrend(epochs, axis=-1)
    x = np.fft.rfft(epochs * signal.windows.hann(width, sym=False), axis=-1)
    freq = np.fft.rfftfreq(width, 1 / hz)
    valid = (freq >= 1) & (freq < 30)
    ps = np.maximum(np.abs(x) ** 2, 1e-100)
    denom = ps[..., valid].sum(axis=-1)
    rel = {key: ps[..., (freq >= lo) & (freq < hi)].sum(axis=-1) / denom for key, (lo, hi) in BANDS.items()}
    log_alpha = np.log(np.maximum(rel["alpha"], 1e-12))
    slowing = np.log((rel["delta"] + rel["theta"]) / (rel["alpha"] + rel["beta"]))
    probs = ps[..., valid] / denom[..., None]
    mask = ((freq >= 3) & (freq < 7)) | ((freq >= 15) & (freq < 28))
    logf = np.log(freq[mask])
    logf -= logf.mean()
    logps = np.log(ps[..., mask])
    slope = (logps @ logf) / (logf @ logf)
    alpha_bins = (freq >= 7) & (freq < 13)
    alpha_peak = freq[alpha_bins][ps[..., alpha_bins].argmax(axis=-1)]
    # Use the same temporal lag at each site for the ordinal statistic.
    from fractions import Fraction
    ratio = Fraction(128 / hz).limit_denominator(1024)
    waveform128 = signal.resample_poly(epochs, ratio.numerator, ratio.denominator, axis=-1)
    wave = ordinal_entropy(signal.sosfiltfilt(signal.butter(3, [1, 30], btype="bandpass", fs=128, output="sos"), waveform128))
    features = {}
    for i, region in enumerate(MONTAGE):
        region_slice = slice(i * 2, i * 2 + 2)
        simple = {**rel, "slowing": slowing, "spectral_entropy": entr(probs).sum(axis=-1) / np.log(probs.shape[-1]),
                  "aperiodic_slope_proxy": slope, "alpha_peak_hz": alpha_peak, "ordinal_entropy": wave}
        for key, data in simple.items():
            features[f"{region}.{key}"] = float(np.median(data[:, region_slice]))
        block = slowing[:, region_slice]
        features[f"{region}.slowing_variability"] = float(stats.iqr(block.mean(axis=1)))
        block = log_alpha[:, region_slice]
        features[f"{region}.alpha_lateral_difference"] = float(np.median(block[:, 0] - block[:, 1]))
        cross = (x[:, 2 * i] * np.conjugate(x[:, 2 * i + 1])).imag
        for band in ("theta", "alpha", "beta"):
            lo, hi = BANDS[band]
            v = cross[:, (freq >= lo) & (freq < hi)]
            features[f"{region}.{band}_phase_lag_index"] = float(np.abs(v.mean(axis=0)).sum() / max(np.abs(v).mean(axis=0).sum(), 1e-120))
    features["posterior_minus_frontal.alpha_log_ratio"] = float(np.median(log_alpha[:, 4:].mean(axis=1) - log_alpha[:, :2].mean(axis=1)))
    features["posterior_minus_frontal.slowing"] = float(np.median(slowing[:, 4:].mean(axis=1) - slowing[:, :2].mean(axis=1)))
    assert np.isfinite(list(features.values())).all()
    return features, len(epochs), count


@dataclass
class Recording:
    participant: str
    group: str
    age: float
    sex: str
    features: dict
    windows: int
    offered: int


def table(path):
    return pd.read_csv(path, sep="\t", encoding="utf-8-sig")


def read_eeglab(path):
    # The pinned OpenNeuro files use EEGLAB MATLAB metadata and either embedded data or an FDT sidecar.
    data = matio.loadmat(path, simplify_cells=True)
    eeg = data.get("EEG", data)
    hz = float(eeg["srate"])
    names = [entry["labels"] for entry in eeg["chanlocs"]]
    values = eeg["data"]
    if isinstance(values, str):
        if Path(values).name != values or not values.endswith(".fdt"):
            raise ValueError("unexpected EEGLAB sidecar")
        values = np.fromfile(path.parent / values, dtype="<f4").reshape((len(names), int(eeg["pnts"])), order="F")
    if not isinstance(values, np.ndarray) or values.ndim != 2 or values.shape[0] != len(names):
        raise ValueError("expected continuous channel by time EEG")
    return bipolar(values, names), hz


def openneuro(dataset, cache, arm="primary"):
    metadata = table(repo_asset(dataset, "participants.tsv", cache))

    def read_one(row):
        pid = row["participant_id"]
        sex = row.get("Gender", row.get("sex", ""))
        age = float(row.get("Age", row.get("age", np.nan)))
        group = str(row.get("Group", row.get("group", "")))
        base = f"{pid}/eeg/{pid}_task-eyesclosed_eeg" if dataset == "ds004504" else f"{pid}/eeg/{pid}_task-rest_eeg"
        start = 2.0
        if dataset == "ds003490":
            if arm == "off" and group != "PD":
                return None, None
            condition = "ON" if arm == "primary" else "OFF"
            session = "02" if row.get("sess2_Med") == condition and row.get("sess1_Med") != condition else "01"
            prefix = f"{pid}_ses-{session}_task-Rest"
            base = f"{pid}/ses-{session}/eeg/{prefix}_eeg"
            events = table(repo_asset(dataset, f"{pid}/ses-{session}/eeg/{prefix}_events.tsv", cache))
            markers = events.loc[events["trial_type"].astype(str).str.contains(r"^Eyes Open:", case=False), "onset"].to_numpy(dtype=float)
            if len(markers) < 50 or np.any(np.diff(markers[:49]) > 1.25):
                raise ValueError("eyes-open marker span unavailable")
            start = float(markers[0] + 1)
            repo_asset(dataset, base + ".fdt", cache, True)
        values, hz = read_eeglab(repo_asset(dataset, base + ".set", cache, True))
        features, windows, offered = extract(values[:, int(round(start * hz)):], hz)
        return Recording(pid, group, age, str(sex)[0].upper(), features, windows, offered), None

    def guarded(row):
        try:
            return read_one(row)
        except (ValueError, KeyError, IndexError, TypeError, OSError, requests.RequestException) as error:
            # Counts by failure reason only. Never emit rows or identifiers.
            message = str(error) if isinstance(error, ValueError) else type(error).__name__
            return None, message.split(":", 1)[0][:105]

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(guarded, metadata.to_dict("records")))
    records = [r for r, _ in results if r is not None]
    errors = dict(Counter(e for _, e in results if e))
    return records, errors


def cejnek(cache):
    metadata = json.loads(download(FIGSHARE, cache / "cejnek" / "release.json").read_text())
    files = [f for f in metadata["files"] if f["name"].lower().endswith(".zip")]
    if len(files) != 1:
        raise ValueError("expected one source ZIP")
    file = files[0]
    release = download(file.get("downloadUrl") or file["download_url"], cache / "cejnek" / file["name"])
    checksum = file.get("computed_md5") or file.get("supplied_md5")
    if not checksum or digest(release, "md5") != checksum:
        raise ValueError("Figshare checksum differs from release")
    with zipfile.ZipFile(release) as archive:
        member_types = Counter((len(Path(n).parts), Path(n).suffix.lower()) for n in archive.namelist())
        print("Cejnek source structure", dict(member_types), flush=True)
        for name in archive.namelist():
            if Path(name).name.lower() == "readme.txt":
                print("Cejnek release README", archive.read(name).decode(errors="replace")[:6500], flush=True)
        for folder in sorted({Path(n).parts[0] for n in archive.namelist() if "/" in n})[:12]:
            files = [n for n in archive.namelist() if n.startswith(folder + "/") and n.endswith(".mat")]
            if files:
                rel = Path(files[0])
                print("Cejnek group layout", folder, len(files), re.sub(r"\d", "#", str(rel)),
                      matio.whosmat(io.BytesIO(archive.read(files[0]))), flush=True)
    raise ValueError("Cejnek source layout must be verified before independent scoring")


def matrices(rows, positive, negative):
    cohort = [r for r in rows if r.group in {positive, negative}]
    if len({r.participant for r in cohort}) != len(cohort):
        raise ValueError("repeated participant in analysis")
    y = np.array([r.group == positive for r in cohort], dtype=int)
    if min(np.bincount(y, minlength=2)) < 5:
        raise ValueError("insufficient patients per group")
    names = list(cohort[0].features)
    x = np.array([[r.features[key] for key in names] for r in cohort])
    meta = np.array([[r.age, r.sex == "M"] for r in cohort])
    return names, x, y, meta


def fdr(pvalues, method="bh"):
    p = np.asarray(pvalues)
    ordered = p.argsort()
    ranks = np.arange(1, len(p) + 1)
    if method == "holm":
        q = np.maximum.accumulate(p[ordered] * (len(p) - ranks + 1))
    else:
        q = np.minimum.accumulate((p[ordered] * len(p) / ranks)[::-1])[::-1]
    result = np.empty(len(p))
    result[ordered] = np.minimum(q, 1)
    return result


def scan(names, x, y, metadata):
    use_meta = np.isfinite(metadata).all() and len(np.unique(metadata[:, 0])) > 1
    design = np.column_stack([np.ones(len(y)), y, metadata]) if use_meta else np.column_stack([np.ones(len(y)), y])
    inverse = np.linalg.pinv(design)
    projection = np.diag(design @ inverse)
    scaled = (x - x.mean(axis=0)) / np.maximum(x.std(axis=0, ddof=1), 1e-10)
    beta = inverse @ scaled
    residual = scaled - design @ beta
    sigma = np.sqrt(np.sum((inverse[1, :, None] * residual / np.maximum(1 - projection[:, None], 1e-8)) ** 2, axis=0))
    dof = len(y) - np.linalg.matrix_rank(design)
    p = 2 * stats.t.sf(np.abs(beta[1]) / np.maximum(sigma, 1e-12), df=dof)
    q = fdr(p)
    critical = stats.t.ppf(.975, df=dof)
    return [{"feature": n, "effect_sd": float(b), "ci": [float(b - critical * s), float(b + critical * s)], "p": float(a), "q_bh": float(d)}
            for n, b, s, a, d in zip(names, beta[1], sigma, p, q)], bool(use_meta)


def score(y, pred):
    roc = float(roc_auc_score(y, pred))
    rng = np.random.default_rng(RNG_SEED)
    positive = np.flatnonzero(y)
    negative = np.flatnonzero(1 - y)
    comparisons = (pred[positive, None] > pred[negative]).astype(float) + .5 * (pred[positive, None] == pred[negative])
    bootstrap = [comparisons[np.ix_(rng.integers(len(positive), size=len(positive)), rng.integers(len(negative), size=len(negative)))].mean() for _ in range(1200)]
    return {"auroc": roc, "auroc_interval": np.quantile(bootstrap, [.025, .975]).tolist(),
            "average_precision": float(average_precision_score(y, pred)), "positive": len(positive), "negative": len(negative)}


def evaluate(train_rows, test_rows, positive, negative, target, test_labels=None):
    names, x, y, meta = matrices(train_rows, positive, negative)
    effects, adjusted = scan(names, x, y, meta)
    shortlist = sorted([e for e in effects if e["q_bh"] <= .1], key=lambda e: e["p"])[:8]
    screening_only = False
    if not shortlist:
        shortlist = sorted(effects, key=lambda e: e["p"])[:3]
        screening_only = True
    mode = "independent cohort" if test_rows else "discovery cohort only"
    report = {"target": target, "evaluation": mode, "feature_count": len(names), "age_sex_adjusted_discovery": adjusted,
              "discovery_n": len(y), "shortlist_screening_only": screening_only, "shortlist": shortlist, "models": {}}
    split = StratifiedKFold(5, shuffle=True, random_state=RNG_SEED)
    feature_sets = {"frontal_standard": [i for i, n in enumerate(names) if n.startswith("frontal.") and n.split(".")[1] in SIMPLE],
                    "all_standard": [i for i, n in enumerate(names) if n.split(".")[1] in SIMPLE],
                    "all_extended": list(range(len(names)))}
    if test_rows:
        ext_names, test_x, test_y, test_meta = matrices(test_rows, *(test_labels or (positive, negative)))
        assert ext_names == names
        ext_effects, ext_adjusted = scan(names, test_x, test_y, test_meta)
        tested = [dict(ext_effects[names.index(r["feature"])]) for r in shortlist]
        q = fdr([e["p"] for e in tested], method="holm")
        for discovered, result, corrected in zip(shortlist, tested, q):
            result["p_holm"] = float(corrected)
            result["replicated"] = bool(not screening_only and corrected < .05 and np.sign(discovered["effect_sd"]) == np.sign(result["effect_sd"]))
        report["replication"] = {"age_sex_adjusted": ext_adjusted, "features": tested}
    for name, selected in {**feature_sets, "nonlinear_extended": feature_sets["all_extended"]}.items():
        train_x = x[:, selected]
        estimator = SVC(C=1, class_weight="balanced") if name == "nonlinear_extended" else LogisticRegression(C=.2, class_weight="balanced", max_iter=400)
        model = make_pipeline(StandardScaler(), estimator)
        predictions = cross_val_predict(model, train_x, y, cv=split, method="decision_function")
        summary = {"internal_oof": score(y, predictions)}
        if test_rows:
            model.fit(train_x, y)
            summary["external"] = score(test_y, model.decision_function(test_x[:, selected]))
        report["models"][name] = summary
    if adjusted:
        model = make_pipeline(StandardScaler(), LogisticRegression(C=.2, class_weight="balanced"))
        summary = {"internal_oof": score(y, cross_val_predict(model, meta, y, cv=split, method="decision_function"))}
        if test_rows and ext_adjusted:
            model.fit(meta, y)
            summary["external"] = score(test_y, model.decision_function(test_meta))
        report["models"]["age_sex_only"] = summary
    return report


def population(rows, errors):
    return {"participants": len(rows), "groups": dict(Counter(r.group for r in rows)),
            "analysed_seconds": 4 * sum(r.windows for r in rows),
            "eligible_offered_seconds": 4 * sum(r.offered for r in rows), "exclusions": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", choices=("dementia", "parkinson"))
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    cache = args.cache
    report = {"task": args.task, "purpose": "retrospective research", "window_seconds": 4, "max_seconds_per_participant": 48}
    if args.task == "parkinson":
        primary, p_errors = openneuro("ds003490", cache)
        external, e_errors = openneuro("ds007526", cache)
        if not external:
            raise SystemExit(f"External Parkinson waveform loading failed: {e_errors}")
        report["cohorts"] = {"ds003490": population(primary, p_errors), "ds007526": population(external, e_errors)}
        report["contrasts"] = [evaluate(primary, external, "PD", "CTL", "Parkinson's vs controls", ("PD", "HC"))]
    else:
        primary, p_errors = openneuro("ds004504", cache)
        try:
            external, e_errors = cejnek(cache)
        except (ValueError, requests.RequestException) as error:
            external, e_errors = [], {"release_status": str(error).split("\n")[0]}
        report["cohorts"] = {"ds004504": population(primary, p_errors), "cejnek": population(external, e_errors)}
        if not primary:
            raise SystemExit(f"Dementia waveform loading failed: {p_errors}")
        report["contrasts"] = [
            evaluate(primary, external, "A", "C", "Alzheimer's vs controls", ("AD", "CONTROL")),
            evaluate(primary, [], "F", "C", "Frontotemporal dementia vs controls"),
            evaluate(primary, [], "A", "F", "Alzheimer's vs frontotemporal dementia"),
        ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
