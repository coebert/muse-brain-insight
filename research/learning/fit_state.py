"""Between-centre transfer of protocol-state classification on matched participants."""

from pathlib import Path
import sys
import json
import numpy as np
from scipy.stats import spearmanr
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
from waveforms import MEASURES


def load(root, site):
    groups = {}
    for path in sorted((root / ("cache-" + site)).glob("*.npz")):
        pid, condition = path.stem.split("-", 1)
        with np.load(path) as d:
            if site == "oslo":
                stage = "baseline" if condition == "awake_acq-EC" else "sedated"
            else:
                stage = ["baseline", "mild", "sedated", "recovery"][int(condition) - 1]
            v = groups.setdefault((pid, stage), {"runs": [], "correct": None})
            v["runs"].append(d["x"])
            if "correct" in d:
                v["correct"] = int(d["correct"])
    return groups


def summarize(groups, site, montage):
    rows = []
    for (pid, state), v in groups.items():
        X = np.concatenate(v["runs"])
        m = X[:, :2] if montage == "frontal" else X
        available = np.isfinite(m).all(axis=(1, 2))
        if available.sum() < 2:
            continue
        # Summarise valid windows of this participant and condition. Left and right are pooled in pairs.
        m = m[available].reshape(available.sum(), m.shape[1] // 2, 2, len(MEASURES))
        feats = np.median(m, axis=(0, 2)).ravel()
        rows.append(
            dict(
                pid=pid,
                site=site,
                state=state,
                x=feats,
                correct=v["correct"],
                windows=int(available.sum()),
            )
        )
    states = {p: {r["state"] for r in rows if r["pid"] == p} for p in {r["pid"] for r in rows}}
    return [r for r in rows if states[r["pid"]] >= {"baseline", "sedated"}]


def train(rows):
    rows = [r for r in rows if r["state"] in ("baseline", "sedated")]
    X = np.stack([r["x"] for r in rows])
    y = np.array([r["state"] == "sedated" for r in rows])
    w = np.array([1 / sum(s["site"] == r["site"] for s in rows) for r in rows])
    w *= len(w) / w.sum()
    scaler = StandardScaler().fit(X, sample_weight=w)
    model = LogisticRegression(C=0.1, solver="liblinear", random_state=401).fit(
        scaler.transform(X), y, sample_weight=w
    )
    return scaler, model


def scores(rows, model):
    scaler, lr = model
    return lr.predict_proba(scaler.transform(np.stack([r["x"] for r in rows])))[:, 1]


def assess(rows, model):
    binary = sorted(
        (r for r in rows if r["state"] in ("baseline", "sedated")),
        key=lambda r: (r["pid"], r["state"]),
    )
    p = scores(binary, model).reshape(-1, 2)
    y = np.tile([0, 1], len(p))
    assert all(
        binary[k]["state"] == "baseline" and binary[k + 1]["pid"] == binary[k]["pid"]
        for k in range(0, len(binary), 2)
    )
    if len(p) < 5:
        raise ValueError("too few complete participant pairs")

    def metrics(a):
        prob = a.ravel()
        truth = np.tile([0, 1], len(a))
        return [
            roc_auc_score(truth, prob),
            average_precision_score(truth, prob),
            np.mean((a[:, 1] > a[:, 0]) + 0.5 * (a[:, 1] == a[:, 0])),
            brier_score_loss(truth, prob),
            np.mean(a[:, 1] >= 0.5),
            np.mean(a[:, 0] < 0.5),
        ]

    rng = np.random.default_rng(401)
    ci = np.quantile(
        [metrics(p[rng.integers(len(p), size=len(p))]) for _ in range(500)], [0.025, 0.975], axis=0
    ).T
    report = dict(
        zip(
            [
                "AUROC",
                "average_precision",
                "paired_ordering",
                "Brier",
                "sensitivity_at_half",
                "specificity_at_half",
            ],
            [{"value": float(v), "interval": c.tolist()} for v, c in zip(metrics(p), ci)],
        )
    )
    simple = np.array(
        [r["x"][1] for r in binary]
    )  # frontal relative delta, fixed positive direction
    report["frontal_delta_baseline_AUROC"] = float(roc_auc_score(y, simple))
    report["paired_participants"] = len(p)
    report["per_stage"] = {
        s: {"participants": len(b), "median_score": float(np.median(scores(b, model)))}
        for s in sorted(set(r["state"] for r in rows))
        if (b := [r for r in rows if r["state"] == s])
    }
    mid = [r for r in rows if r["state"] == "sedated" and r["correct"] is not None]
    if len(mid) >= 5:
        rho, pvalue = spearmanr(scores(mid, model), [r["correct"] for r in mid])
        report["moderate_sedation_score_vs_correct_responses"] = {
            "spearman": float(rho),
            "p_unadjusted": float(pvalue),
            "n": len(mid),
        }
    return report


def behaviour(rows):
    """Leave each participant out of all fits and compare waveform scores with protocol stage."""
    rows = [r for r in rows if r["correct"] is not None]
    target = np.array([r["correct"] for r in rows])
    eeg = np.stack([r["x"] for r in rows])
    groups = np.array([r["pid"] for r in rows])
    stage = np.array([r["state"] for r in rows])
    encoded = np.stack([stage == s for s in ("mild", "sedated", "recovery")], axis=1).astype(float)
    yhat = {
        name: np.zeros(len(rows))
        for name in ("training_median", "protocol_stage", "EEG", "EEG_plus_stage")
    }
    for pid in np.unique(groups):
        test = groups == pid
        train = ~test
        yhat["training_median"][test] = np.median(target[train])
        yhat["protocol_stage"][test] = [np.mean(target[train & (stage == s)]) for s in stage[test]]
        for name, X in [("EEG", eeg), ("EEG_plus_stage", np.column_stack([eeg, encoded]))]:
            model = make_pipeline(StandardScaler(), Ridge(alpha=20)).fit(X[train], target[train])
            yhat[name][test] = np.clip(model.predict(X[test]), 0, 40)
    metrics = {}
    for name, p in yhat.items():
        within = stage == "sedated"
        metrics[name] = {
            "mean_absolute_error_correct_responses": float(np.mean(abs(p - target))),
            "moderate_stage_mean_absolute_error": float(np.mean(abs(p[within] - target[within]))),
            "moderate_stage_spearman": (
                float(spearmanr(p[within], target[within])[0]) if np.std(p[within]) > 1e-6 else None
            ),
        }
    # Positive gain means the combined model makes fewer errors than stage alone.
    gains = abs(yhat["protocol_stage"] - target) - abs(yhat["EEG_plus_stage"] - target)
    means = [np.mean(gains[groups == pid]) for pid in np.unique(groups)]
    rng = np.random.default_rng(175)
    metrics["patient_mean_MAE_gain_EEG_plus_stage_vs_stage"] = {
        "value": float(np.mean(means)),
        "interval": np.quantile(
            rng.choice(means, (2000, len(means)), replace=True).mean(axis=1), [0.025, 0.975]
        ).tolist(),
    }
    return {"sessions": len(rows), "participants": len(set(groups)), "metrics": metrics}


def main(root, out):
    sources = {site: load(root, site) for site in ("cambridge", "oslo")}
    result = {}
    all_models = {}
    for montage in ("frontal", "broader"):
        sites = {site: summarize(groups, site, montage) for site, groups in sources.items()}
        if min(len({r["pid"] for r in v}) for v in sites.values()) < 12:
            raise ValueError("incomplete cohort")
        result[montage] = {"correct_response_prediction": behaviour(sites["cambridge"])}
        for target, other in [("oslo", "cambridge"), ("cambridge", "oslo")]:
            result[montage][other + "_to_" + target] = assess(sites[target], train(sites[other]))
        sc, model = train(sites["cambridge"] + sites["oslo"])
        all_models[montage] = {
            "feature_order": [
                f"{reg}.{f}"
                for reg in (
                    ["frontal"] if montage == "frontal" else ["frontal", "central", "posterior"]
                )
                for f in MEASURES
            ],
            "mean": sc.mean_.tolist(),
            "scale": sc.scale_.tolist(),
            "coef": model.coef_[0].tolist(),
            "intercept": float(model.intercept_[0]),
        }
    result["source_accounting"] = {
        site: {
            "participants": len({k[0] for k in v}),
            "recordings": sum(len(a["runs"]) for a in v.values()),
            "candidate_windows": sum(len(x) for a in v.values() for x in a["runs"]),
        }
        for site, v in sources.items()
    }
    result["label"] = (
        "Protocol state. Cambridge baseline vs moderate propofol, Oslo eyes-closed baseline vs pre-awakening propofol."
    )
    result["unit"] = (
        "One score per participant and state after summarising available 8-second windows."
    )
    out.mkdir(parents=True, exist_ok=True)
    (out / "propofol-transfer-results.json").write_text(
        json.dumps(result, indent=2, allow_nan=False) + "\n"
    )
    (out / "propofol-research-weights.json").write_text(
        json.dumps({"version": 1, "purpose": result["label"], "models": all_models}, indent=2)
        + "\n"
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
