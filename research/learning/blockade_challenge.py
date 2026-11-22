"""Fit low-band propofol comparators and report aggregate cross-centre results."""

import json
from pathlib import Path
import sys
import numpy as np
from scipy.special import expit
from fit_state import load, train, scores
from sklearn.metrics import roc_auc_score


def low_features(e):
    # Both ratios cancel the common full-spectrum denominator. Avoid a fixed additive pseudocount.
    low = np.array(e[..., 1:4], dtype=float)
    valid = np.isfinite(low).all(axis=-1) & (low.min(axis=-1) > 0)
    low[~valid] = np.nan
    return np.log(low[..., 1:] / low[..., :1])


def region_summary(e):
    good = np.isfinite(e).all(axis=(1, 2))
    if good.sum() < 2:
        return None
    return np.median(e[good].reshape(good.sum(), e.shape[1] // 2, 2, 2), axis=(0, 2)).ravel()


def study_rows(groups, n, site):
    out = []
    for (pid, state), item in groups.items():
        if state not in ("sedated", "baseline"):
            continue
        e = np.concatenate(item["runs"])[:, :n]
        x = region_summary(low_features(e))
        if x is not None:
            out.append(dict(pid=pid, site=site, state=state, x=x))
    return sorted(
        (v for v in out if sum(r["pid"] == v["pid"] for r in out) == 2),
        key=lambda r: (r["pid"], r["state"]),
    )


def heldout(rows, model):
    s = scores(rows, model).reshape(-1, 2)
    truth = np.tile([0, 1], len(s))

    def auc(x):
        return roc_auc_score(truth, x.ravel())

    rng = np.random.default_rng(145)
    return dict(
        pairs=len(s),
        auroc=auc(s),
        participant_bootstrap_95=np.quantile(
            [auc(s[rng.integers(0, len(s), len(s))]) for _ in range(1000)], [0.025, 0.975]
        ).tolist(),
        sensitivity_at_half=float(np.mean(s[:, 1] >= 0.5)),
        specificity_at_half=float(np.mean(s[:, 0] < 0.5)),
    )


def fit(root):
    results = {}
    models = {}
    groups = {s: load(root, s) for s in ["cambridge", "oslo"]}
    for n, montage in [(2, "frontal"), (6, "broader")]:
        sites = {s: study_rows(g, n, s) for s, g in groups.items()}
        results[montage] = {}
        for tr, te in [("cambridge", "oslo"), ("oslo", "cambridge")]:
            results[montage][tr + "_to_" + te] = heldout(sites[te], train(sites[tr]))
        sc, lr = train(sites["oslo"] + sites["cambridge"])
        models[montage] = dict(
            mean=sc.mean_.tolist(),
            scale=sc.scale_.tolist(),
            coef=lr.coef_[0].tolist(),
            intercept=float(lr.intercept_[0]),
            features=["log(theta/delta)", "log(alpha/delta)"],
            regions=["frontal", "central", "posterior"][: n // 2],
        )
        for rows in sites.values():
            x = np.stack([r["x"] for r in rows])
            assert np.allclose(
                expit((x - sc.mean_) / sc.scale_ @ lr.coef_[0] + lr.intercept_[0]),
                scores(rows, (sc, lr)),
            )
    return models, results


if __name__ == "__main__":
    root = Path(sys.argv[1])
    models, result = fit(root)
    out = root / "results"
    (out / "low-band-propofol-weights.json").write_text(json.dumps(models, indent=2))
    (out / "blockade-challenge-results.json").write_text(
        json.dumps({"heldout_protocol": result}, indent=2)
    )
