"""Refit the complete early-to-late classifier after shuffling whole-person labels."""

import json, sys
from pathlib import Path
import numpy as np
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score
from temporal_features import summarize
from temporal_study import estimate, prob


def main(root, repeats=199):
    rows = []
    for p in sorted((root / "raw-dementia").glob("*.npz")):
        with np.load(p) as rec:
            early, late = [summarize(w)[0] for w in rec["x"]]
            if early is not None and late is not None:
                rows.append((rec["group"].item(), early, late))
    out = {}
    rng = np.random.default_rng(491071)
    for pos, neg in [("A", "F"), ("A", "C"), ("F", "C")]:
        part = [r for r in rows if r[0] in [pos, neg]]
        x = np.stack([r[1] for r in part])
        z = np.stack([r[2] for r in part])
        y = np.array([r[0] == pos for r in part])

        def score(labels):
            predictions = np.zeros(len(y))
            for seed in [47, 93, 173, 479, 887]:
                for tr, te in StratifiedKFold(5, shuffle=True, random_state=seed).split(
                    x, labels
                ):
                    predictions[te] += prob(estimate(x[tr], labels[tr]), z[te])
            return roc_auc_score(labels, predictions / 5)

        observed = score(y)
        null = np.array([score(rng.permutation(y)) for _ in range(repeats)])
        out[pos + "_vs_" + neg] = dict(
            observed_AUROC=observed,
            permutations=repeats,
            null_median=np.median(null),
            null_95=np.quantile(null, [0.025, 0.975]).tolist(),
            one_sided_p=(1 + int(sum(null >= observed))) / (1 + repeats),
        )
        print(pos, neg, out[pos + "_vs_" + neg], flush=True)
    from scipy.stats import false_discovery_control

    for k, q in zip(
        out, false_discovery_control([v["one_sided_p"] for v in out.values()], method="by")
    ):
        out[k]["BY_q"] = float(q)
    (root / "temporal-results/diagnosis-permutation.json").write_text(
        json.dumps(out, indent=2) + "\n"
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
