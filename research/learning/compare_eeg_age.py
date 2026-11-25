"""Offline research comparison for chronological age from resting EEG."""

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.stats import binomtest
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from validate_brain_age import SEED, array, cohort, features


def load_cohorts():
    athens = []
    for path in sorted(Path("raw-dementia").glob("*.npz")):
        with np.load(path, allow_pickle=False) as record:
            if str(record["group"]) == "C":
                row = features(record["x"][0])
                if row is not None:
                    athens.append((path.stem, float(record["age"]), "", row))
    return {
        "dortmund": cohort("ds005385", "ses-1"),
        "oslo": cohort("ds003775", "ses-t1"),
        "athens": athens,
    }


def age_stratum(y):
    return np.minimum(y // 10, 6)


def split(indices, y, fraction):
    return train_test_split(
        indices, test_size=fraction, stratify=age_stratum(y[indices]), random_state=SEED
    )


def ridge(penalty=35):
    return make_pipeline(
        SimpleImputer(strategy="median", keep_empty_features=True),
        StandardScaler(),
        Ridge(alpha=penalty),
    )


def conformal_radius(y, prediction):
    rank = int(np.ceil((len(y) + 1) * 0.90))
    if rank > len(y):
        raise ValueError("90% split conformal requires at least nine calibration participants")
    return float(np.sort(np.abs(y - prediction))[rank - 1])


def predictions(x, y, fit, adjust, interval, target):
    bins, counts = np.unique(age_stratum(y[fit]), return_counts=True)
    weights = np.interp(age_stratum(y[fit]), bins, len(fit) / (len(bins) * counts))
    candidates = {
        "ridge35": (ridge(), slice(None), {}),
        "ridge5": (ridge(5), slice(None), {}),
        "age_balanced_ridge35": (ridge(), slice(None), {"ridge__sample_weight": weights}),
        "nonlinear_boosting": (
            HistGradientBoostingRegressor(max_iter=100, max_leaf_nodes=7, random_state=SEED),
            slice(None),
            {},
        ),
        "two_frontal_derivations": (ridge(), slice(0, 9), {}),
        "two_central_derivations": (ridge(), slice(9, 18), {}),
    }
    output = {}
    for name, (model, cols, params) in candidates.items():
        model.fit(x[fit, cols], y[fit], **params)
        point = model.predict(target[:, cols])
        calibration = model.predict(x[interval, cols])
        output[name] = point, conformal_radius(y[interval], calibration)
        if name == "ridge35":
            threshold = np.median(model.predict(x[fit, cols]))
            low = calibration <= threshold
            if min(low.sum(), (~low).sum()) >= 9:
                lower_radius = conformal_radius(y[interval][low], calibration[low])
                upper_radius = conformal_radius(y[interval][~low], calibration[~low])
            else:
                lower_radius = upper_radius = output[name][1]
            output["ridge35_prediction_stratified_interval"] = (
                point, np.where(point <= threshold, lower_radius, upper_radius)
            )
            # Learn observed age from out-of-fit predictions. At scoring only EEG is used.
            affine = LinearRegression(positive=True).fit(
                model.predict(x[adjust, cols]).reshape(-1, 1), y[adjust]
            )
            output["affine_ridge35"] = (
                affine.predict(point.reshape(-1, 1)),
                conformal_radius(y[interval], affine.predict(calibration.reshape(-1, 1))),
            )
    median = np.median(y[fit])
    output["source_median"] = (
        np.full(len(target), median),
        conformal_radius(y[interval], np.full(len(interval), median)),
    )
    return output


def summarize(y, point, radius):
    error = point - y
    hits = int((np.abs(error) <= radius).sum())
    coverage = binomtest(hits, len(y)).proportion_ci()
    return {
        "n": len(y),
        "mae": float(np.mean(np.abs(error))),
        "signed_error": float(np.mean(error)),
        "predicted_on_observed_slope": float(np.polyfit(y, point, 1)[0])
        if np.ptp(y) > 0 else None,
        "coverage_90": hits / len(y),
        "coverage_ci95": [coverage.low, coverage.high],
        "mean_interval_width": float(np.mean(2 * radius)),
    }


def evaluate(y, variants, reference):
    result = {}
    rng = np.random.default_rng(SEED)
    resamples = rng.integers(0, len(y), (2000, len(y)))
    for name, (point, radius) in variants.items():
        radius = np.broadcast_to(radius, y.shape)
        delta = np.abs(point - y) - np.abs(variants[reference][0] - y)
        result[name] = {
            **summarize(y, point, radius),
            "paired_mae_difference_ci95": np.percentile(
                delta[resamples].mean(axis=1), [2.5, 97.5]
            ).tolist(),
            "age_strata": {
                f"{lower}-{lower + 9}": summarize(y[mask], point[mask], radius[mask])
                for lower in range(20, 80, 10)
                if (mask := (y >= lower) & (y < lower + 10)).sum() >= 5
            },
        }
    return result


def run(cohorts, frozen, require_reference_counts=True):
    expected = {"dortmund": 490, "oslo": 76, "athens": 14}
    data = {}
    for site, count in expected.items():
        rows = cohorts[site]
        if not rows:
            raise ValueError(f"{site}: no eligible source recordings found")
        ids, y, _, x = array(rows)
        if len(set(ids)) != len(ids) or not np.isfinite(y).all():
            raise ValueError(f"{site}: repeated participants or missing ages")
        eligible = (y >= frozen["age_range"][0]) & (y <= frozen["age_range"][1])
        data[site] = x[eligible], y[eligible]
        if require_reference_counts and eligible.sum() != count:
            raise ValueError(f"{site}: expected {count} eligible participants, found {eligible.sum()}")

    x, y = data["dortmund"]
    idx = np.arange(len(y))
    internal = {}
    folds = StratifiedKFold(5, shuffle=True, random_state=SEED)
    for development, test in folds.split(x, age_stratum(y)):
        fit, held_back = split(development, y, 0.30)
        adjust, interval = split(held_back, y, 0.60)
        for name, (point, radius) in predictions(x, y, fit, adjust, interval, x[test]).items():
            all_points, all_radii = internal.setdefault(name, (np.empty(len(y)), np.empty(len(y))))
            all_points[test] = point
            all_radii[test] = radius

    result = {"dortmund_nested": evaluate(y, internal, "ridge35")}
    overlap = {}
    for site, (_, ages) in data.items():
        overlap[site] = {
            "n": len(ages),
            "age_range": [float(ages.min()), float(ages.max())],
            "age_sd": float(ages.std()),
        }
    result["cohorts"] = overlap
    # Match the original 80/20 split, reserving part of its fit pool for
    # candidate point calibration. Neither external cohort can affect fits.
    source_fit, interval = split(idx, y, 0.20)
    fit, adjust = split(source_fit, y, 0.20)
    for site in ("oslo", "athens"):
        target, labels = data[site]
        output = predictions(x, y, fit, adjust, interval, target)
        normalized = (
            np.where(np.isfinite(target), target, frozen["impute"]) - frozen["mean"]
        ) / frozen["scale"]
        point = normalized @ frozen["coef"] + frozen["intercept"]
        output["published_frozen"] = point, np.full(len(labels), frozen["interval_half_width"])
        result[site] = evaluate(labels, output, "published_frozen")
        if require_reference_counts:
            expected_mae, expected_hits = {"oslo": (8.736581238, 69), "athens": (18.606932500, 8)}[site]
            baseline = result[site]["published_frozen"]
            if not (np.isclose(baseline["mae"], expected_mae, rtol=0, atol=1e-6)
                    and round(baseline["coverage_90"] * len(labels)) == expected_hits):
                raise ValueError(f"{site}: frozen baseline differs from the reference release")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Path for aggregate results JSON")
    args = parser.parse_args()
    frozen = json.loads(Path("temporal-results/brain-age-weights.json").read_text())
    result = run(load_cohorts(), frozen)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
