"""Compare the existing 13-descriptor research representation with the addition of timing."""

import json, sys
from pathlib import Path
import numpy as np
from temporal_features import EXTRA_NAMES, summarize
from temporal_study import pairs, estimate, prob, auc_report, auc_boot, serialize
from waveforms import features, MEASURES


def run(root):
    data = {}
    for site in ("cambridge", "oslo"):
        g = {}
        for f in sorted((root / ("raw-" + site)).glob("*.npz")):
            pid, condition = f.stem.split("-", 1)
            if site == "cambridge" and condition not in ("1", "3"):
                continue
            awake = condition in ("1", "awake_acq-EC")
            with np.load(f) as rec:
                w = rec["x"]
                w = w[np.linspace(0, len(w) - 1, min(4, len(w)), dtype=int)]
            timing, usable = summarize(w)
            if timing is None:
                continue
            z = np.stack([features(a, 125)[0] for a in w])
            good = np.isfinite(z).all(axis=(1, 2))
            if good.sum() < 2:
                continue
            old = np.median(
                z[good].reshape(good.sum(), 3, 2, len(MEASURES)), axis=(0, 2)
            ).ravel()
            g.setdefault((pid, "baseline" if awake else "sedated"), []).append(
                np.r_[old, timing[15:]]
            )
        data[site] = pairs({k: (np.median(v, axis=0), None) for k, v in g.items()})
    d = {}
    n = 3 * len(MEASURES)
    for a, b in [("cambridge", "oslo"), ("oslo", "cambridge")]:
        x, y, _ = data[a]
        z, t, groups = data[b]
        p = prob(estimate(x[:, :n], y), z[:, :n])
        q = prob(estimate(x, y), z)
        d[a + "_to_" + b] = dict(
            people=len(np.unique(groups)),
            incumbent=auc_report(t, p),
            augmented=auc_report(t, q),
            contrast=auc_boot(t, q, p, groups),
        )
    x = np.concatenate([v[0] for v in data.values()])
    y = np.concatenate([v[1] for v in data.values()])
    names = [
        r + "." + f for r in ["frontal", "central", "posterior"] for f in MEASURES
    ] + EXTRA_NAMES
    for key, val in [
        ("incumbent-comparison", d),
        ("incumbent-augmented-weights", serialize(estimate(x, y), names)),
    ]:
        (root / "temporal-results" / (key + ".json")).write_text(
            json.dumps(val, indent=2, allow_nan=False) + "\n"
        )


if __name__ == "__main__":
    run(Path(sys.argv[1]))
