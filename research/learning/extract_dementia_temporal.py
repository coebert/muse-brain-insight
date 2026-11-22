"""Extract two non-overlapping segments after verification against the pinned OpenNeuro release."""

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import sys
import numpy as np
from scipy import signal

try:
    from discover import repo_asset, read_eeglab, table
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "discovery"))
    from discover import repo_asset, read_eeglab, table


def extract(root):
    dataset = "ds004504"
    cache = root / "source-cache"
    dest = root / "raw-dementia"
    dest.mkdir(exist_ok=True)
    metadata = table(repo_asset(dataset, "participants.tsv", cache))

    def one(row):
        pid = row["participant_id"]
        out = dest / (pid + ".npz")
        if out.exists():
            return
        name = f"{pid}/eeg/{pid}_task-eyesclosed_eeg.set"
        path = repo_asset(dataset, name, cache, True)
        data, hz = read_eeglab(path)
        width = int(48 * hz)
        pad = int(4 * hz)
        if data.shape[1] < 2 * (width + pad):
            raise ValueError("Too short for disjoint blocks")
        blocks = []
        for start in [pad, data.shape[1] - pad - width]:
            frac = Fraction(125 / hz).limit_denominator(4096)
            x = signal.resample_poly(
                data[:, start : start + width], frac.numerator, frac.denominator, axis=1
            )
            blocks.append(x.reshape(6, 6, 1000).transpose(1, 0, 2))
        np.savez_compressed(
            out,
            x=np.asarray(blocks, dtype="float32"),
            group=row["Group"],
            age=float(row["Age"]),
            sex=row["Gender"],
            mmse=float(row["MMSE"]),
        )
        print("verified recordings", len(list(dest.glob("*.npz"))), flush=True)

    with ThreadPoolExecutor(6) as pool:
        list(pool.map(one, metadata.to_dict("records")))


if __name__ == "__main__":
    extract(Path(sys.argv[1]))
