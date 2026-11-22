"""Subject-separated protocol and diagnosis analyses. Publish group results only."""

import argparse
import json
import itertools
from pathlib import Path
import numpy as np
from scipy.special import expit
from scipy.stats import false_discovery_control, spearmanr
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.model_selection import StratifiedKFold, LeaveOneGroupOut
from temporal_features import BASIC_NAMES, EXTRA_NAMES, summarize

NAMES = BASIC_NAMES + EXTRA_NAMES
SETS = {
    "spectrum": np.arange(len(BASIC_NAMES)),
    "timing_only": np.arange(len(BASIC_NAMES), len(NAMES)),
    "combined": np.arange(len(NAMES)),
    "frontal_combined": np.array([i for i, s in enumerate(NAMES) if s.startswith("frontal.")]),
}


def estimate(x, y, kind="classification"):
    sc = StandardScaler().fit(x)
    model = (
        LogisticRegression(C=0.1, class_weight="balanced", max_iter=1000)
        if kind == "classification"
        else Ridge(alpha=20)
    ).fit(sc.transform(x), y)
    return sc, model


def prob(fit, x):
    sc, m = fit
    return m.predict_proba(sc.transform(x))[:, 1]


def serialize(fit, features):
    sc, m = fit
    return dict(
        features=features,
        mean=sc.mean_.tolist(),
        scale=sc.scale_.tolist(),
        coef=m.coef_[0].tolist(),
        intercept=float(m.intercept_[0]),
    )


def ci(x):
    return np.quantile(x, [0.025, 0.975]).tolist()


def auc_report(y, p):
    return dict(
        auroc=roc_auc_score(y, p),
        sensitivity=float(np.mean(p[y == 1] >= 0.5)),
        specificity=float(np.mean(p[y == 0] < 0.5)),
        brier=brier_score_loss(y, p),
    )


def auc_boot(y, p, q, groups, B=800):
    ids = np.unique(groups)
    ix = [np.flatnonzero(groups == g) for g in ids]
    rng = np.random.default_rng(8923)
    out = []
    for _ in range(B):
        b = np.concatenate([ix[k] for k in rng.integers(len(ids), size=len(ids))])
        if len(np.unique(y[b])) == 2:
            # Mann-Whitney form also handles tied scores.
            def auc(z):
                s = z[b]
                d = s[y[b] == 1, None] - s[y[b] == 0][None, :]
                return np.mean((d > 0) + 0.5 * (d == 0))

            a, c = auc(p), auc(q)
            out.append((a, c, a - c))
    return dict(
        combined_interval=ci(np.array(out)[:, 0]),
        spectrum_interval=ci(np.array(out)[:, 1]),
        delta=roc_auc_score(y, p) - roc_auc_score(y, q),
        delta_interval=ci(np.array(out)[:, 2]),
    )


def phase_sites(root):
    groups = {}
    totals = {}
    for site in ["cambridge", "oslo", "oslo-eyes-open"]:
        tmp = {}
        seen = usable = 0
        for f in sorted((root / ("raw-" + site)).glob("*.npz")):
            pid, cond = f.stem.split("-", 1)
            stage = (
                ["baseline", "mild", "sedated", "recovery"][int(cond) - 1]
                if site == "cambridge"
                else ("baseline" if "awake" in cond else "sedated")
            )
            with np.load(f) as z:
                x = z["x"]
                feat, n = summarize(x, limit=4)
                correct = int(z["correct"]) if "correct" in z else None
                all_observed = len(x)
            seen += min(all_observed, 4)
            usable += n
            if feat is not None:
                tmp.setdefault((pid, stage), []).append((feat, correct))
        groups[site] = {
            k: (np.median([z[0] for z in v], axis=0), v[0][1]) for k, v in tmp.items()
        }
        totals[site] = dict(
            recordings=len(list((root / ("raw-" + site)).glob("*.npz"))),
            candidate_windows=seen,
            valid_windows=usable,
            valid_states=len(tmp),
        )
    return groups, totals


def pairs(group):
    people = [
        pid
        for pid in sorted({k[0] for k in group})
        if (pid, "baseline") in group and (pid, "sedated") in group
    ]
    x = np.stack([group[(p, s)][0] for p in people for s in ["baseline", "sedated"]])
    return x, np.tile([0, 1], len(people)), np.repeat(people, 2)


def paired_features(x):
    d = x[1::2] - x[::2]
    rng = np.random.default_rng(2318)
    signs = rng.choice([-1.0, 1.0], (10000, len(d)))
    null = np.abs(signs @ d / len(d))
    p = (1 + (null >= np.abs(d.mean(axis=0)) - 1e-14).sum(axis=0)) / (len(null) + 1)
    return d.mean(axis=0) / np.maximum(d.std(axis=0, ddof=1), 1e-15), p


def behaviour(group):
    keys = sorted(group)
    states = np.array([v[1] for v in keys])
    pids = np.array([v[0] for v in keys])
    x = np.stack([group[k][0] for k in keys])
    y = np.array([group[k][1] for k in keys], float)
    stage = np.column_stack([states == s for s in ("mild", "sedated", "recovery")]).astype(
        float
    )
    pred = {}
    for name, cols in [
        ("stage", None),
        ("stage_spectrum", SETS["spectrum"]),
        ("stage_combined", SETS["combined"]),
    ]:
        fitted = np.zeros(len(y))
        for tr, te in LeaveOneGroupOut().split(x, y, pids):
            if cols is None:
                fitted[te] = [y[tr][states[tr] == s].mean() for s in states[te]]
            else:
                # Force the protocol stage as a fixed training-only comparator. Regress within-stage residuals.
                base = np.array([y[tr][states[tr] == s].mean() for s in states])
                centred = np.stack(
                    [
                        x[i, cols] - x[tr][:, cols][states[tr] == s].mean(axis=0)
                        for i, s in enumerate(states)
                    ]
                )
                sc, m = estimate(centred[tr], (y - base)[tr], "regression")
                fitted[te] = np.clip(base[te] + m.predict(sc.transform(centred[te])), 0, 40)
        pred[name] = fitted

    def gain(a, b):
        d = np.abs(pred[a] - y) - np.abs(pred[b] - y)
        g = np.array([d[pids == p].mean() for p in np.unique(pids)])
        return dict(
            mean=float(g.mean()),
            interval=ci(np.random.default_rng(144).choice(g, (3000, len(g))).mean(axis=1)),
        )

    return dict(
        sessions=len(y),
        participants=len(np.unique(pids)),
        MAE={k: float(np.mean(abs(v - y))) for k, v in pred.items()},
        gain_over_stage=gain("stage", "stage_combined"),
        gain_over_spectrum=gain("stage_spectrum", "stage_combined"),
    )


def state_analysis(root):
    g, counts = phase_sites(root)
    source = {k: pairs(g[k]) for k in ["cambridge", "oslo"]}
    out = {}
    drugs = {}
    for train, test in [("cambridge", "oslo"), ("oslo", "cambridge")]:
        a, l, _ = source[train]
        x, y, pid = source[test]
        pred = {}
        result = {}
        for name, cols in SETS.items():
            fit = estimate(a[:, cols], l)
            s = prob(fit, x[:, cols])
            pred[name] = s
            result[name] = auc_report(y, s)
            if test == "oslo" and name in ["combined", "spectrum"]:
                eye = g["oslo-eyes-open"]
                idx = [i for i in range(0, len(pid), 2) if (pid[i], "baseline") in eye]
                z = np.stack([eye[(pid[i], "baseline")][0] for i in idx])
                e = prob(fit, z[:, cols])
                result[name]["eyes_open_check"] = dict(
                    pairs=len(idx),
                    closed_false_sedated=int(sum(s[idx] >= 0.5)),
                    open_false_sedated=int(sum(e >= 0.5)),
                )
        result["paired_bootstrap"] = auc_boot(y, pred["combined"], pred["spectrum"], pid)
        result["held_out_people"] = len(np.unique(pid))
        out[train + "_to_" + test] = result
    effect = {k: paired_features(v[0]) for k, v in source.items()}
    d1, p1 = effect["cambridge"]
    d2, p2 = effect["oslo"]
    # Replicability requires both sites to pass; control multiplicity across all candidate features.
    composite = np.where(np.sign(d1) == np.sign(d2), np.maximum(p1, p2), 1.0)
    # Benjamini-Yekutieli is valid under arbitrary dependence.
    q = false_discovery_control(composite, method="by")
    replication = [
        dict(
            feature=n,
            cambridge_dz=float(d1[j]),
            oslo_dz=float(d2[j]),
            joint_p=float(composite[j]),
            joint_q=float(q[j]),
        )
        for j, n in enumerate(NAMES)
    ]
    x = np.concatenate([z[0] for z in source.values()])
    y = np.concatenate([z[1] for z in source.values()])
    for name, cols in SETS.items():
        drugs[name] = serialize(estimate(x[:, cols], y), [NAMES[i] for i in cols])
    return (
        dict(
            counts=counts,
            cross_site=out,
            features=replication,
            behaviour=behaviour(g["cambridge"]),
        ),
        drugs,
    )


def dementia_analysis(root):
    rows = []
    windows = [0, 0]
    for p in sorted((root / "raw-dementia").glob("*.npz")):
        with np.load(p) as z:
            parts = [summarize(b) for b in z["x"]]
            for i, (_, n) in enumerate(parts):
                windows[i] += n
            if all(x is not None for x, _ in parts):
                rows.append(
                    (
                        z["group"].item(),
                        [float(z["age"]), float(z["sex"].item() == "M"), float(z["mmse"])],
                        parts[0][0],
                        parts[1][0],
                    )
                )
    out = {}
    models = {}
    for positive, negative in [("A", "F"), ("A", "C"), ("F", "C")]:
        cohort = [r for r in rows if r[0] in (positive, negative)]
        y = np.array([int(r[0] == positive) for r in cohort])
        meta = np.array([r[1] for r in cohort])
        x, z = [np.stack([r[b] for r in cohort]) for b in [2, 3]]
        specs = {
            "spectrum": (x[:, :15], z[:, :15]),
            "combined": (x, z),
            "timing_only": (x[:, 15:], z[:, 15:]),
            "age_sex": (meta[:, :2], meta[:, :2]),
        }
        if negative == "F":
            specs.update(
                age_sex_mmse=(meta, meta),
                clinical_plus_spectrum=(np.c_[meta, x[:, :15]], np.c_[meta, z[:, :15]]),
                clinical_plus_combined=(np.c_[meta, x], np.c_[meta, z]),
            )
        predictions = {}
        summaries = {}
        # Each held-out individual is absent from scaling and fitting in every repeat.
        for name, (early, late) in specs.items():
            inner = []
            outer = []
            for seed in (47, 93, 173, 479, 887):
                pm = np.empty(len(y))
                pn = np.empty(len(y))
                for tr, te in StratifiedKFold(5, shuffle=True, random_state=seed).split(
                    early, y
                ):
                    fit = estimate(early[tr], y[tr])
                    pm[te] = prob(fit, early[te])
                    pn[te] = prob(fit, late[te])
                inner.append(pm)
                outer.append(pn)
            early_score = np.mean(inner, axis=0)
            late_score = np.mean(outer, axis=0)
            predictions[name] = late_score
            summaries[name] = dict(
                early_auroc=roc_auc_score(y, early_score),
                late=auc_report(y, late_score),
                recording_end_agreement=float(
                    np.mean((early_score >= 0.5) == (late_score >= 0.5))
                ),
            )
        contrasts = {
            "combined_vs_spectrum": auc_boot(
                y, predictions["combined"], predictions["spectrum"], np.arange(len(y))
            )
        }
        if negative == "F":
            contrasts["adding_timing_to_clinical_and_spectrum"] = auc_boot(
                y,
                predictions["clinical_plus_combined"],
                predictions["clinical_plus_spectrum"],
                np.arange(len(y)),
            )
        out[positive + "_vs_" + negative] = dict(
            positive=int(y.sum()),
            negative=int((1 - y).sum()),
            models=summaries,
            contrasts=contrasts,
        )
        models[positive + "_vs_" + negative] = serialize(estimate(x, y), NAMES)
    return (
        dict(
            downloaded=len(list((root / "raw-dementia").glob("*.npz"))),
            eligible=len(rows),
            valid_windows=windows,
            contrasts=out,
        ),
        models,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("task", choices=["protocol", "dementia"])
    parser.add_argument("root", type=Path)
    a = parser.parse_args()
    result, weights = (state_analysis if a.task == "protocol" else dementia_analysis)(a.root)
    dest = a.root / "temporal-results"
    dest.mkdir(exist_ok=True)
    for name, content in [("results", result), ("research-weights", weights)]:
        (dest / (a.task + "-" + name + ".json")).write_text(
            json.dumps(content, indent=2, allow_nan=False) + "\n"
        )
