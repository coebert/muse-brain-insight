"""Fit, calibrate, and evaluate resting EEG age with participants as the sampling unit."""

import json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from brain_age import features, NAMES, score, MONTAGE

OUT = Path("temporal-results")
SEED = 1977


def save(name, obj):
    (OUT / name).write_text(json.dumps(obj, indent=2, allow_nan=False) + "\n")


def cohort(ds, session):
    info = pd.read_csv(f"age-meta/{ds}-participants.tsv", sep="\t").set_index("participant_id")
    rows = []
    for p in sorted((Path("age-raw") / ds).glob(f"*_{session}_*.npz")):
        pid = p.name.split("_")[0]
        with np.load(p) as z:
            feat = features(z["x"])
        if feat is not None:
            rows.append(
                (pid, float(info.at[pid, "age"]), str(info.at[pid, "sex"]).upper(), feat)
            )
    return rows


def array(rows):
    return tuple(np.asarray(a) for a in zip(*rows))


def fit(x, y):
    return make_pipeline(
        SimpleImputer(strategy="median", keep_empty_features=True),
        StandardScaler(),
        Ridge(alpha=35),
    ).fit(x, y)


def ci(values, fn=np.mean):
    a = np.asarray(values)
    rng = np.random.default_rng(SEED)
    return np.percentile(
        fn(a[rng.integers(0, len(a), (2000, len(a)))], axis=1), [2.5, 97.5]
    ).tolist()


def metrics(y, p, b, sex):
    err = p - y
    gain = np.abs(y - b) - np.abs(err)
    out = {
        "n": len(y),
        "age_range": [float(y.min()), float(y.max())],
        "mae": float(np.abs(err).mean()),
        "mae_ci95": ci(abs(err)),
        "median_baseline_mae": float(np.abs(y - b).mean()),
        "gain_ci95": ci(gain),
        "bias": float(err.mean()),
        "r2": float(r2_score(y, p)),
        "rank_r": float(stats.spearmanr(y, p).statistic),
        "predicted_on_observed_slope": float(np.polyfit(y, p, 1)[0]),
        "strata": {},
    }
    for k, mask in [(f"{lo}-{lo+9}", (y >= lo) & (y < lo + 10)) for lo in range(20, 80, 10)] + [
        (str(s), sex == s) for s in np.unique(sex)
    ]:
        if mask.sum() >= 5:
            out["strata"][k] = {
                "n": int(mask.sum()),
                "bias": float(err[mask].mean()),
                "mae": float(np.abs(err[mask]).mean()),
            }
    return out


def associations(x, y):
    out = {}
    for name, v in zip(NAMES, x.T):
        good = np.isfinite(v)
        r = stats.spearmanr(v[good], y[good])
        out[name] = {
            "n": int(good.sum()),
            "rho": float(r.statistic),
            "p": float(r.pvalue),
            "slope_per_decade": float(np.polyfit(y[good], v[good], 1)[0] * 10),
        }
    for a, q in zip(
        out.values(), stats.false_discovery_control([a["p"] for a in out.values()], method="by")
    ):
        a["q"] = float(q)
    return out


def main():
    ids, y, sex, x = array(cohort("ds005385", "ses-1"))
    repeat = {r[0]: r[3] for r in cohort("ds005385", "ses-2")}
    pred = np.zeros(len(y))
    base = pred.copy()
    feature_sets = {
        "frontal_only": np.arange(9),
        "band_power_only": np.array([i for i in range(27) if i % 9 < 6]),
    }
    restricted = {k: pred.copy() for k in feature_sets}
    delta = []
    elapsed = []
    for tr, te in StratifiedKFold(5, shuffle=True, random_state=SEED).split(
        x, np.minimum(y // 10, 6)
    ):
        m = fit(x[tr], y[tr])
        pred[te] = m.predict(x[te])
        for k, cols in feature_sets.items():
            restricted[k][te] = fit(x[tr][:, cols], y[tr]).predict(x[te][:, cols])
        base[te] = np.median(y[tr])
        for i in te:
            if ids[i] in repeat:
                years = (
                    pd.read_csv(Path("age-meta") / f"{ids[i]}-sessions.tsv", sep="\t")
                    .set_index("session_id")
                    .recording_year
                )
                elapsed.append(float(years["ses-2"] - years["ses-1"]))
                delta.append(m.predict(repeat[ids[i]][None, :])[0] - pred[i])
    train, cal = train_test_split(
        np.arange(len(y)), test_size=0.20, stratify=np.minimum(y // 10, 6), random_state=SEED
    )
    final = fit(x[train], y[train])
    scores = sorted(abs(final.predict(x[cal]) - y[cal]))
    half = float(scores[int(np.ceil((len(cal) + 1) * 0.9)) - 1])
    imputer, scale, ridge = final.steps
    weights = {
        "version": 1,
        "purpose": "research only, chronological-age prediction in awake adult eyes-closed resting EEG",
        "montage": MONTAGE,
        "features": NAMES,
        "age_range": [float(y[train].min()), float(y[train].max())],
        "impute": imputer[1].statistics_.tolist(),
        "mean": scale[1].mean_.tolist(),
        "scale": scale[1].scale_.tolist(),
        "coef": ridge[1].coef_.tolist(),
        "intercept": float(ridge[1].intercept_),
        "interval_half_width": half,
    }
    save("brain-age-weights.json", weights)
    results = {
        "development": metrics(y, pred, base, sex),
        "associations_dortmund": associations(x, y),
        "training_n": len(train),
        "calibration_n": len(cal),
        "interval_half_width": half,
        "longitudinal": {
            "n": len(delta),
            "mean_change": float(np.mean(delta)),
            "mean_change_ci95": ci(delta),
            "mean_elapsed_calendar_years": float(np.mean(elapsed)),
            "mean_absolute_change_error": float(np.mean(np.abs(np.asarray(delta) - elapsed))),
            "median_change": float(np.median(delta)),
            "change_middle_80pct": np.percentile(delta, [10, 90]).tolist(),
            "fraction_increased": float(np.mean(np.asarray(delta) > 0)),
        },
    }
    results["dortmund_comparators"] = {
        k: {
            "mae": float(np.mean(abs(v - y))),
            "full_model_gain_ci95": ci(abs(v - y) - abs(pred - y)),
        }
        for k, v in restricted.items()
    }
    results["decade_medians"] = {}
    for lo in range(20, 70, 10):
        ix = (y >= lo) & (y < (lo + 10) if lo < 60 else y <= 70)
        results["decade_medians"][f"{lo}-{lo+9 if lo<60 else 70}"] = {
            name: float(np.nanmedian(x[ix, i])) for i, name in enumerate(NAMES)
        }
    greek = []
    for p in sorted(Path("raw-dementia").glob("*.npz")):
        with np.load(p) as z:
            if str(z["group"]) != "C":
                continue
            feat = features(z["x"][0])
            if feat is not None:
                greek.append((p.stem, float(z["age"]), str(z["sex"]), feat))
    for key, rows in [("oslo", cohort("ds003775", "ses-t1")), ("athens", greek)]:
        site_ids, actual, s, v = array(rows)
        eligible = (actual >= weights["age_range"][0]) & (actual <= weights["age_range"][1])
        actual, s, v = actual[eligible], s[eligible], v[eligible]
        yp = final.predict(v)
        res = metrics(actual, yp, np.median(y[train]), s)
        res.update(
            {
                "outside_reference_age": int((~eligible).sum()),
                "interval_coverage": float((abs(yp - actual) <= half).mean()),
                "local_leave_one_out_median_mae": float(
                    np.mean(
                        [abs(a - np.median(np.delete(actual, i))) for i, a in enumerate(actual)]
                    )
                ),
            }
        )
        res["comparators"] = {
            k: float(
                np.mean(abs(fit(x[train][:, cols], y[train]).predict(v[:, cols]) - actual))
            )
            for k, cols in feature_sets.items()
        }
        results[key] = res
        if key == "oslo":
            results["associations_oslo"] = associations(v, actual)
            clinical = (
                pd.read_csv("age-meta/ds003775-participants.tsv", sep="\t")
                .set_index("participant_id")
                .loc[site_ids[eligible]]
            )
            tests = {}
            for field in ("ravlt_del", "tmt_3"):
                target = pd.to_numeric(clinical[field], errors="coerce").to_numpy()
                ok = np.isfinite(target)
                design = np.column_stack(
                    [np.ones(ok.sum()), actual[ok], actual[ok] ** 2, s[ok] == "F"]
                )

                def residual(a):
                    return a - design @ np.linalg.lstsq(design, a, rcond=None)[0]

                assoc = stats.pearsonr(residual(yp[ok] - actual[ok]), residual(target[ok]))
                tests[field] = {
                    "n": int(ok.sum()),
                    "partial_r": float(assoc.statistic),
                    "p": float(
                        2
                        * stats.t.sf(
                            abs(assoc.statistic)
                            * np.sqrt((ok.sum() - 5) / (1 - assoc.statistic**2)),
                            ok.sum() - 5,
                        )
                    ),
                }
            for record, q in zip(
                tests.values(),
                stats.false_discovery_control([v["p"] for v in tests.values()], method="by"),
            ):
                record["q"] = float(q)
            results["oslo_exploratory_cognition"] = tests
    # A deliberately unsupported state challenge, bypassing the replay guard offline.
    shifts = []
    for path in sorted(Path("raw-cambridge").glob("*-1.npz")):
        stages = []
        for phase in (1, 3):
            with np.load(path.with_name(path.name.replace("-1.npz", f"-{phase}.npz"))) as data:
                v = features(data["x"][:6])
            if v is not None:
                stages.append(final.predict(v[None, :])[0])
        if len(stages) == 2:
            shifts.append(stages[1] - stages[0])
    if shifts:
        results["propofol_challenge"] = {
            "n": len(shifts),
            "mean_shift": float(np.mean(shifts)),
            "mean_shift_ci95": ci(shifts),
            "median_absolute_shift": float(np.median(np.abs(shifts))),
        }
    save("brain-age-results.json", results)
    print(
        {
            k: {
                a: b
                for a, b in v.items()
                if a in ["n", "mae", "rank_r", "median_baseline_mae", "mean_change"]
            }
            for k, v in results.items()
            if isinstance(v, dict)
        }
    )


if __name__ == "__main__":
    main()
