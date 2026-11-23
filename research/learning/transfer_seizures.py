"""Age-domain transfer check on preselected CHB-MIT and Siena scalp recordings."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote

import numpy as np
import joblib
import requests
from sklearn.metrics import roc_auc_score, average_precision_score
from sedation import get
from waveforms import PAIRS, SECONDS, features
from fit_seizures import case, apply_calibration, raw_scores, alarm_counts

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eeg"))
from train import chb_annotations, siena_annotations, clock

ROOT = "https://physionet-open.s3.amazonaws.com/"
SITES = {
    "chb": ("chbmit", [f"chb{i:02d}" for i in range(1, 13)]),
    "siena": ("siena-scalp-eeg", [f"PN{i:02d}" for i in (0, 1, 3, 5, 6, 9)]),
}


def extract_file(url, intervals, purpose):
    first = get(url, 0, 255)
    if first[:8].strip() != b"0":
        raise ValueError("expected EDF")
    headlen = int(first[184:192])
    nr = int(first[236:244])
    dur = float(first[244:252])
    nc = int(first[252:256])
    h = io.BytesIO(get(url, 256, headlen - 1))

    def strings(n):
        a = h.read(n * nc)
        return [a[i * n : (i + 1) * n].decode("latin1").strip() for i in range(nc)]

    def norm(s):
        s = re.sub(r"^EEG\s+|[- ]REF$", "", s.upper())
        return "-".join(
            {"T7": "T3", "T8": "T4", "P7": "T5", "P8": "T6"}.get(x, x) for x in s.split("-")
        )

    labels = [norm(x) for x in strings(16)]
    strings(80)
    units = strings(8)
    lo, hi, dmin, dmax = [np.array(strings(8), float) for _ in range(4)]
    strings(80)
    ns = np.asarray(strings(8), int)
    strings(32)
    offs = np.r_[0, ns.cumsum()]
    if h.tell() != headlen - 256 or dur != 1 or nr < 60 or np.any(ns <= 0):
        raise ValueError("unsupported file header")
    if any(not 0 <= a < b <= nr for a, b in intervals):
        raise ValueError("annotation outside EDF")
    if purpose == "event":
        a, b = intervals[0]
        start = max(0, a - 600)
        stop = min(nr, max(b + 600, start + 1200))
    else:
        start = 0
        stop = min(600, nr)
    stop = start + (stop - start) // SECONDS * SECONDS
    stride = int(ns.sum()) * 2
    payload = get(url, headlen + start * stride, headlen + stop * stride - 1)
    data = np.frombuffer(payload, "<i2").reshape(stop - start, -1)

    def electrode(index):
        if units[index].lower().replace("µ", "u").replace("μ", "u") != "uv":
            raise ValueError("non-microvolt channels")
        vals = data[:, offs[index] : offs[index + 1]].reshape(-1).astype("float64")
        return (vals - dmin[index]) * (hi[index] - lo[index]) / (dmax[index] - dmin[index]) + lo[
            index
        ]

    def fetch_pair(a, b):
        label = a + "-" + b
        idx = [i for i, x in enumerate(labels) if x == label]
        if idx:
            vals = electrode(idx[0])
            if any(not np.allclose(vals, electrode(j), atol=0.15) for j in idx[1:]):
                raise ValueError("conflicting duplicates")
            return vals, ns[idx[0]]
        if labels.count(a) == labels.count(b) == 1 and ns[labels.index(a)] == ns[labels.index(b)]:
            return electrode(labels.index(a)) - electrode(labels.index(b)), ns[labels.index(a)]
        raise ValueError("missing bipolar pair")

    X = []
    rate = None
    for a, b in PAIRS:
        try:
            values, hz = fetch_pair(a, b)
            if rate is None:
                rate = hz
            if rate != hz:
                raise ValueError("sample rate mismatch")
            X.append(values)
        except ValueError:
            if len(X) < 2:
                raise
            X.append(np.full((stop - start) * rate, np.nan))
    votes = np.zeros(stop - start, dtype="int8")
    for a, b in intervals:
        if a < stop and b > start:
            votes[max(0, a - start) : min(stop, b) - start] = 3
    return features(np.stack(X), rate), votes, hashlib.sha256(payload).hexdigest(), start, stop


def prepare(folder):
    folder.mkdir(parents=True, exist_ok=True)

    def one(unit):
        site, pid = unit
        ds = SITES[site][0]
        base = f"{ROOT}{ds}/1.0.0/{pid}/"
        f = pid + "-summary.txt" if site == "chb" else "Seizures-list-" + pid + ".txt"
        annotation = get(base + f).decode("latin1")
        mapping = (chb_annotations if site == "chb" else siena_annotations)(annotation)
        if site == "siena" and pid in {"PN01", "PN06"}:
            # Two released annotation files use legacy names. Confirm the EDF time as well.
            listing = get(f"{ROOT}{ds}/1.0.0/RECORDS").decode().splitlines()
            actual = f"{pid}-1.edf"
            if f"{pid}/{actual}" not in listing:
                raise ValueError("expected annotated version absent from source")
            start_match = re.search(r"Registration start time:\s*([0-9.:]+)", annotation, re.I)
            origin = clock(start_match[1])
            if clock(get(base + actual, 0, 255)[176:184].decode()) != origin:
                raise ValueError("annotated and EDF start times disagree")
            if pid == "PN01":
                blocks = re.split(r"Seizure n\s*\d+", annotation, flags=re.I)[1:]
                periods = []
                for block in blocks:
                    a = re.search(r"Start time:\s*([0-9.:]+)", block, re.I)
                    b = re.search(r"End time:\s*([0-9.:]+)", block, re.I)
                    if not a or not b:
                        raise ValueError("missing single-file seizure times")
                    periods.append(((clock(a[1]) - origin) % 86400, (clock(b[1]) - origin) % 86400))
                mapping = {actual: periods}
            else:
                mapping = {name.replace("PNO6-", "PN06-"): iv for name, iv in mapping.items()}
        event = next(((file, v, "event") for file, v in mapping.items() if v), None)
        background = next(((file, v, "background") for file, v in mapping.items() if not v), None)
        errors = []
        for item in (event, background):
            if not item:
                continue
            file, iv, purpose = item
            dest = folder / f"{site}_{pid}_{purpose}.npz"
            if dest.exists():
                continue
            try:
                x, votes, digest, start, stop = extract_file(base + quote(file), iv, purpose)
            except (ValueError, OSError, requests.RequestException) as error:
                errors.append(f"{pid} {purpose}: {type(error).__name__} {str(error)[:120]}")
                continue
            np.savez_compressed(dest, x=x, votes=votes, sha256=digest, start=start, stop=stop)
            print(site, pid, purpose, len(votes), flush=True)
        if not event:
            errors.append(pid + " no matched seizure file")
        return errors

    units = [(s, p) for s, (_, ids) in SITES.items() for p in ids]
    with ThreadPoolExecutor(max_workers=4) as pool:
        errors = [err for batch in pool.map(one, units) for err in batch]
    (folder / "exclusions.json").write_text(json.dumps(errors, indent=2))


def assess(folder, out):
    report = {}
    for site in SITES:
        files = sorted(folder.glob(site + "_*.npz"))
        report[site] = {}
        for montage in ("frontal", "broader"):
            model = joblib.load(out / f"neonatal-{montage}.joblib")
            ys = []
            ps = []
            patients = {}
            eligible = total = 0
            latency = []
            for path in files:
                r = case(path, montage)
                p = apply_calibration(model["calibration"], raw_scores(model["model"], r))
                ok = np.isfinite(p)
                ys.extend(r["y"][ok])
                ps.extend(p[ok])
                count, delay = alarm_counts(r, p, model["threshold"])
                patient = path.stem.split("_")[1]
                patients[patient] = patients.get(patient, np.zeros(6)) + count
                latency += delay
                eligible += int(ok.sum())
                total += len(p)
            if not patients:
                continue
            h, e, f, s, o, a = sum(patients.values(), np.zeros(6))
            report[site][montage] = {
                "patients": len(patients),
                "segments": len(files),
                "hours_sampled": total * SECONDS / 3600,
                "scorable_fraction": eligible / max(1, total),
                "events": int(e),
                "detected": int(h),
                "false_alarm_starts": int(f),
                "false_alarm_starts_per_background_hour": float(f * 3600 / s) if s else None,
                "background_hours": s / 3600,
                "window_AUROC": float(roc_auc_score(ys, ps)) if len(set(ys)) == 2 else None,
                "window_average_precision": (
                    float(average_precision_score(ys, ps)) if len(set(ys)) == 2 else None
                ),
                "window_prevalence": float(np.mean(ys)) if ys else None,
            }
    report["source_exclusions"] = json.loads((folder / "exclusions.json").read_text())
    (out / "age-transfer-results.json").write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n"
    )


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        prepare(Path(sys.argv[2]))
    else:
        assess(Path(sys.argv[2]), Path(sys.argv[3]))
