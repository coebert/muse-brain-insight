"""Offline EEG signal features. Inputs are physical microvolts, grouped by recording."""

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import time
import tempfile
import json
import re
import sys

import numpy as np
import pandas as pd
import requests
from scipy import signal
from scipy.special import entr

BANDS = [(0.5, 4), (4, 8), (8, 13), (13, 20), (20, 30), (30, 42)]
MEASURES = [
    "log_rms",
    "delta",
    "theta",
    "alpha",
    "low_beta",
    "high_beta",
    "gamma",
    "entropy",
    "edge95",
    "peak_hz",
    "log_line_length",
    "log_peak_to_rms",
    "autocorr",
]
PAIRS = [
    ("FP1", "F7"),
    ("FP2", "F8"),
    ("F3", "C3"),
    ("F4", "C4"),
    ("P3", "O1"),
    ("P4", "O2"),
    ("T3", "T5"),
    ("T4", "T6"),
]
SECONDS = 8


def features(x, hz):
    """Return one row per 8 s window. Preserve invalid windows to measure coverage."""
    n = round(SECONDS * hz)
    count = x.shape[1] // n
    e = x[:, : count * n].reshape(len(x), count, n).transpose(1, 0, 2)
    results = []
    for b in np.array_split(e, max(1, int(np.ceil(len(e) / 80)))):
        finite = np.isfinite(b).all(axis=2)
        b = np.where(np.isfinite(b), b, 0)
        spread = np.ptp(b, axis=2)
        good = finite & (spread >= 1) & (spread < 1200)
        b = signal.detrend(b, axis=2)
        f, ps = signal.welch(b, fs=hz, nperseg=round(2 * hz), axis=2)
        keep = (f >= 0.5) & (f < 42)
        p = ps[..., keep]
        freq = f[keep]
        rel = p / np.maximum(p.sum(axis=2, keepdims=True), 1e-30)
        rms = np.sqrt((b * b).mean(axis=2))
        lag = max(1, round(hz / 8))
        ac = (b[..., :-lag] * b[..., lag:]).mean(axis=2) / np.maximum(rms * rms, 1e-20)
        feats = [np.log1p(rms)] + [
            rel[..., (freq >= lo) & (freq < hi)].sum(axis=2) for lo, hi in BANDS
        ]
        feats += [
            entr(rel).sum(axis=2) / np.log(len(freq)),
            freq[(rel.cumsum(axis=2) >= 0.95).argmax(axis=2)],
            freq[rel.argmax(axis=2)],
            np.log1p(np.abs(np.diff(b, axis=2)).mean(axis=2) * hz),
            np.log1p(spread / np.maximum(rms, 1e-20)),
            ac,
        ]
        values = np.stack(feats, axis=2)
        values[~good] = np.nan
        results.append(values.astype("float32"))
    return np.concatenate(results)


def to_file(entry, dest):
    expected = entry["checksum"].removeprefix("md5:")
    if (
        Path(dest).is_file()
        and Path(dest).stat().st_size == entry["size"]
        and hashlib.md5(Path(dest).read_bytes()).hexdigest() == expected
    ):
        return
    urls = [
        entry["links"]["self"],
        "https://zenodo.org/records/2547147/files/" + entry["key"] + "?download=1",
    ]
    for attempt in range(5):
        try:
            h = hashlib.md5()
            with requests.get(urls[attempt % 2], stream=True, timeout=(15, 100)) as r:
                r.raise_for_status()
                with open(dest, "wb") as f:
                    for part in r.iter_content(1024 * 1024):
                        h.update(part)
                        f.write(part)
            if h.hexdigest() != expected:
                raise ValueError("waveform checksum mismatch")
            return
        except (requests.RequestException, ValueError):
            if attempt == 4:
                raise
            time.sleep(2**attempt)


def read_edf(path):
    """Decode native 16-bit EDF by record and scale each selected electrode to microvolts."""
    with path.open("rb") as src:
        header = src.read(256)
        if header[:8].strip() != b"0":
            raise ValueError("expected EDF")
        length = int(header[184:192])
        nr = int(header[236:244])
        dur = float(header[244:252])
        nc = int(header[252:256])

        def strings(n):
            raw = src.read(n * nc)
            return [raw[i * n : (i + 1) * n].decode("latin1").strip() for i in range(nc)]

        labels = strings(16)
        strings(80)
        units = strings(8)
        pmin, pmax, dmin, dmax = [np.array(strings(8), dtype=float) for _ in range(4)]
        strings(80)
        ns = np.array(strings(8), dtype=int)
        strings(32)
        if src.tell() != length or dur <= 0:
            raise ValueError("unexpected EDF header")
        if path.stat().st_size - length != nr * ns.sum() * 2:
            raise ValueError("EDF size mismatch")
    data = np.memmap(path, dtype="<i2", mode="r", offset=length, shape=(nr, int(ns.sum())))
    canonical = [re.sub(r"^EEG\s+|[- ]REF$", "", s.upper().strip()) for s in labels]
    offsets = np.r_[0, np.cumsum(ns)]

    def electrode(name):
        if canonical.count(name) != 1:
            raise ValueError("ambiguous electrode " + name)
        j = canonical.index(name)
        if units[j].lower().replace("µ", "u").replace("μ", "u") != "uv" or dmax[j] <= dmin[j]:
            raise ValueError("incompatible electrode scaling")
        physical = data[:, offsets[j] : offsets[j + 1]].reshape(-1).astype("float64")
        return (physical - dmin[j]) * (pmax[j] - pmin[j]) / (dmax[j] - dmin[j]) + pmin[j]

    rates = {ns[canonical.index(s)] / dur for pair in PAIRS for s in pair}
    if len(rates) != 1:
        raise ValueError("mixed electrode sample rates")
    return np.stack([electrode(a) - electrode(b) for a, b in PAIRS]), rates.pop()


def prepare(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    manifest = Path(__file__).with_name("helsinki-manifest.json")
    entries = json.loads(manifest.read_text())
    ann = []
    for letter in "ABC":
        dest = path / f"{letter}.csv"
        to_file(entries[f"annotations_2017_{letter}.csv"], dest)
        ann.append(pd.read_csv(dest))

    def one(i):
        out = path / f"{i}.npz"
        if out.exists():
            return
        with tempfile.TemporaryDirectory(dir=path) as tmp:
            dest = Path(tmp) / "wave.edf"
            to_file(entries[f"eeg{i}.edf"], dest)
            channels, hz = read_edf(dest)
            fx = features(channels, hz)
            labels = np.stack([a[str(i)].to_numpy() for a in ann], axis=1)
            n = min(len(fx), len(labels) // SECONDS)
            labels = labels[: n * SECONDS]
            known = np.isin(labels, [0, 1]).all(axis=1)
            votes = np.where(known, labels.sum(axis=1), -1).astype("int8")
            np.savez_compressed(
                out, x=fx[:n], votes=votes, checksum=entries[f"eeg{i}.edf"]["checksum"]
            )
            print(f"completed neonatal recording {i} ({n} windows)", flush=True)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(one, range(1, 80)))


if __name__ == "__main__":
    prepare(sys.argv[1])
