"""Extract the same 48 seconds from each pinned, eyes-closed resting EEG."""

import concurrent.futures as futures
import io
import json
from fractions import Fraction
from pathlib import Path
import sys
import numpy as np
import pandas as pd
import requests
from scipy.signal import resample_poly

RELEASES = {"ds005385": "1.0.2", "ds003775": "1.2.1"}
PAIRS = [("FP1", "F7"), ("FP2", "F8"), ("F3", "C3"), ("F4", "C4"), ("P3", "O1"), ("P4", "O2")]


def decode(stream):
    head = stream.read(256)
    count = int(head[252:256])
    duration = float(head[244:252])
    buf = io.BytesIO(stream.read(256 * count))

    def field(width):
        return [buf.read(width).decode("latin1").strip() for _ in range(count)]

    names = [n.upper().removeprefix("EEG ").removesuffix("-REF") for n in field(16)]
    field(80)
    units = field(8)
    pmin, pmax, dmin, dmax = [np.asarray(field(8), float) for _ in range(4)]
    field(80)
    ns = np.asarray(field(8), int)
    indices = [names.index(n) for pair in PAIRS for n in pair]
    records = int(np.ceil(52 / duration))
    size = int(ns.sum())
    data = np.frombuffer(stream.read(records * size * 2), dtype="<i2").reshape(records, size)
    offset = np.r_[0, np.cumsum(ns)]
    signals = []
    for i in indices:
        unit = units[i].lower().replace("µ", "u")
        factor = {"uv": 1, "mv": 1000, "v": 1e6}[unit]
        hz = ns[i] / duration
        x = data[:, offset[i] : offset[i + 1]].reshape(-1).astype(float)
        x = ((x - dmin[i]) * (pmax[i] - pmin[i]) / (dmax[i] - dmin[i]) + pmin[i]) * factor
        rate = Fraction(125 / float(hz)).limit_denominator(4096)
        signals.append(resample_poly(x, rate.numerator, rate.denominator)[500:6500])
    return (
        (np.asarray(signals)[::2] - np.asarray(signals)[1::2])
        .reshape(6, 6, 1000)
        .transpose(1, 0, 2)
    )


def extract(item):
    ds, path = item
    out = Path("age-raw") / ds / (Path(path).stem + ".npz")
    if out.exists():
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    url = (
        f"https://openneuro.org/crn/datasets/{ds}/snapshots/{RELEASES[ds]}/files/"
        + path.replace("/", ":")
    )
    for attempt in range(3):
        try:
            with requests.get(url, stream=True, timeout=(10, 35)) as r:
                r.raise_for_status()
                r.raw.decode_content = True
                x = decode(r.raw)
            np.savez_compressed(out, x=x.astype("float32"))
            return
        except Exception as err:
            last = err
    print("excluded", path, str(last)[:140], flush=True)


def main():
    tasks = []
    for ds in RELEASES:
        paths = [i["path"] for i in json.load(open(f"age-meta/{ds}-tree.json"))["tree"]]
        suffix = (
            "task-EyesClosed_acq-pre_eeg.edf" if ds == "ds005385" else "task-resteyesc_eeg.edf"
        )
        rows = pd.read_csv(f"age-meta/{ds}-participants.tsv", sep="\t").set_index(
            "participant_id"
        )
        for p in paths:
            if not p.startswith("sub-") or not p.endswith(suffix):
                continue
            pid, visit = p.split("/")[:2]
            if ds == "ds005385" and rows.loc[pid, "late_ses" + visit[-1]] != 0:
                continue
            if ds == "ds003775" and visit != "ses-t1":
                continue
            tasks.append((ds, p))
    np.random.default_rng(381).shuffle(tasks)
    with futures.ThreadPoolExecutor(24) as pool:
        for i, _ in enumerate(pool.map(extract, tasks)):
            if i % 50 == 0:
                print(i, len(tasks), flush=True)


if __name__ == "__main__":
    main()
