"""Apply fixed Helsinki models and thresholds to independent paediatric and adult clips."""

from pathlib import Path
import json, sys
import numpy as np
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score, average_precision_score
from scipy.special import expit
from fit_seizures import (
    case,
    train,
    raw_scores,
    calibrate,
    apply_calibration,
    operating_point,
    alarm_counts,
)
from seizure_history import add_history


def run(root, ext, out):
    base = [case(root / f"{i}.npz", "broader") for i in range(1, 80)]
    tr, ca = next(
        StratifiedKFold(5, shuffle=True, random_state=941).split(
            base, [bool(r["events"]) for r in base]
        )
    )
    report = {}
    weights = {}
    for name in ("current_window", "past_and_current"):
        transform = add_history if name == "past_and_current" else lambda r: r
        cohort = [transform(r) for r in base]
        model = train(cohort, tr, "linear")
        pc = {i: raw_scores(model, cohort[i]) for i in ca}
        recal = calibrate(cohort, ca, pc)
        t = operating_point(cohort, ca, {i: apply_calibration(recal, v) for i, v in pc.items()})
        sc, lr = model.steps[0][1], model.steps[1][1]
        weights[name] = dict(
            mean=sc.mean_.tolist(),
            scale=sc.scale_.tolist(),
            coef=lr.coef_[0].tolist(),
            intercept=float(lr.intercept_[0]),
            calibration_coef=float(recal.coef_[0, 0]),
            calibration_intercept=float(recal.intercept_[0]),
            threshold=t,
        )
        report[name] = {}
        for site in ("chb", "siena"):
            total = np.zeros(6)
            ys = []
            ps = []
            people = set()
            segments = 0
            for file in sorted(ext.glob(site + "_*.npz")):
                r = transform(case(file, "broader"))
                raw = raw_scores(model, r)
                p = apply_calibration(recal, raw)
                ok = np.isfinite(p) & (r["y"] >= 0)
                ys.extend(r["y"][ok])
                ps.extend(p[ok])
                total += alarm_counts(r, p, t)[0]
                people.add(file.stem.split("_")[1])
                segments += 1
                if ok.any():
                    manual = expit(
                        (r["x"][ok] - sc.mean_) / sc.scale_ @ lr.coef_[0] + lr.intercept_[0]
                    )
                    assert np.allclose(raw[ok], manual)
            hit, events, false, seconds, _, _ = total
            if not len(people):
                raise ValueError("No external records for " + site)
            report[name][site] = dict(
                people=len(people),
                clips=segments,
                detected=int(hit),
                events=int(events),
                false_starts=int(false),
                background_hours=seconds / 3600,
                false_starts_per_background_hour=false * 3600 / seconds,
                window_auroc=roc_auc_score(ys, ps),
                window_average_precision=average_precision_score(ys, ps),
            )
    out.mkdir(exist_ok=True)
    for file, data in [("neonatal-transfer", report), ("neonatal-history-weights", weights)]:
        (out / (file + ".json")).write_text(json.dumps(data, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    run(*(Path(v) for v in sys.argv[1:]))
