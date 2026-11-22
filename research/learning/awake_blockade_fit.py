"""Fit research comparators to the six participants' published frontal alpha medians."""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import requests
from scipy.special import expit
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

URL = "https://media.springernature.com/full/springer-static/esm/art%3A10.1038%2Fs41598-026-50911-6/MediaObjects/41598_2026_50911_MOESM1_ESM.pdf"
# Pinned before any fit: a different supplement must not silently replace the
# source of the six-participant comparison.
SOURCE_SHA256 = "a0a9131f04a66a89a0c5cbcee55ff40c3800abbc4f27ae3b6e6e34e0f67fc307"
STATES = ["awake_unparalysed", "awake_cisatracurium", "propofol_sedation_blockade_protocol"]

# The four published confusion-count tuples, as (awake pre-block, awake
# paralysed, propofol protocol) out of six participants. The fit must reproduce
# these exactly or refuse to write results.
PUBLISHED_CONFUSION = {
    ("absolute", "omit_awake_blockade"): (1, 1, 5),
    ("absolute", "with_awake_blockade"): (0, 1, 5),
    ("change_from_own_awake_baseline", "omit_awake_blockade"): (0, 1, 6),
    ("change_from_own_awake_baseline", "with_awake_blockade"): (0, 1, 6),
}


def verify_source(path):
    """Return the PDF digest, refusing anything but the pinned supplement."""
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError(f"unexpected source PDF SHA-256: {digest}")
    return digest


def extract(path):
    import fitz

    page = fitz.open(path)[5]
    assert "Figure S3" in page.get_text() and "frontal" in page.get_text()
    draws = page.get_drawings()
    # White dots in the violins mark the median. Calibrate each panel separately using its own y-axis.
    dots = [
        d["rect"]
        for d in draws
        if d["fill"] == (1.0, 1.0, 1.0)
        and 450 < d["rect"].x0 < 520
        and 2.2 < d["rect"].width < 2.5
        and abs(d["rect"].height - d["rect"].width) < 0.01
    ]
    assert len(dots) == 18
    words = [
        w for w in page.get_text("words") if 420 < w[0] < 440 and w[4] in ("11", "12", "13")
    ]
    assert len(words) == 18
    ticks = [
        d["rect"]
        for d in draws
        if d["type"] == "fs"
        and d["rect"].height < 0.001
        and 4.6 < d["rect"].width < 4.9
        and 435 < d["rect"].x0 < 445
    ]
    assert len(ticks) == 18
    calibrated = []
    for i in range(6):
        trio = sorted(words, key=lambda w: w[1])[3 * i : 3 * i + 3]
        assert [w[4] for w in trio] == ["11", "12", "13"]
        y = np.array([min(ticks, key=lambda b: abs(b.y0 - (w[1] + w[3]) / 2)).y0 for w in trio])
        assert max(abs(np.diff(y) - np.mean(np.diff(y)))) < 0.01
        marks = sorted(sorted(dots, key=lambda b: b.y0)[3 * i : 3 * i + 3], key=lambda b: b.x0)
        centres = np.array([(b.y0 + b.y1) / 2 for b in marks])
        assert np.all((centres > y[0] - 10) & (centres < y[2] + 10)) and all(
            20 < d < 29 for d in np.diff([r.x0 for r in marks])
        )
        calibrated.append((-11 - (centres - y[0]) / np.mean(np.diff(y))).tolist())
    return np.array(calibrated)


def folds(n):
    """Leave one participant out: (training indices, held-out index) pairs."""
    index = np.arange(n)
    return [(index[index != held], held) for held in range(n)]


def change_from_baseline(x):
    """Use each participant's own pre-block awake measurement as the reference."""
    return x - x[:, [0]]


def fit(x, y):
    """Fit scaling and the comparator on the supplied rows only."""
    sc = StandardScaler().fit(x.reshape(-1, 1))
    lr = LogisticRegression(C=1, class_weight="balanced", solver="lbfgs", random_state=713).fit(
        sc.transform(x.reshape(-1, 1)), y
    )
    return dict(
        mean=float(sc.mean_[0]),
        scale=float(sc.scale_[0]),
        coef=float(lr.coef_[0, 0]),
        intercept=float(lr.intercept_[0]),
    )


def predict(data, spec):
    return expit((data - spec["mean"]) / spec["scale"] * spec["coef"] + spec["intercept"])


def grouped_leave_one_out(samples, cols):
    """Predict every participant from a model that never saw them."""
    labels = np.array([k == 2 for k in cols])
    predictions = np.zeros((len(samples), len(STATES)))
    for train, held in folds(len(samples)):
        obs = samples[train][:, cols]
        model = fit(obs.ravel(), np.tile(labels, len(train)))
        predictions[held] = predict(samples[held], model)
    return predictions


def counts(predictions):
    """The published confusion-count tuple: pre-block, paralysed, propofol."""
    return tuple(int(sum(predictions[:, k] >= 0.5)) for k in range(len(STATES)))


def main(root):
    path = root / "halder-sup.pdf"
    if not path.exists():
        r = requests.get(URL, timeout=90)
        r.raise_for_status()
        path.write_bytes(r.content)
    digest = verify_source(path)
    x = extract(path)
    result = {}
    weights = {}
    for mode in ["absolute", "change_from_own_awake_baseline"]:
        samples = x if mode == "absolute" else change_from_baseline(x)
        result[mode] = {}
        for include in [False, True]:
            cols = [0, 1, 2] if include else [0, 2]
            name = "with_awake_blockade" if include else "omit_awake_blockade"
            p = grouped_leave_one_out(samples, cols)
            observed = counts(p)
            expected = PUBLISHED_CONFUSION[(mode, name)]
            if observed != expected:
                raise ValueError(
                    f"{mode}/{name} confusion counts {observed} != published {expected}"
                )
            result[mode][name] = dict(
                awake_pre_false_sedated=observed[0],
                awake_blockade_false_sedated=observed[1],
                propofol_protocol_detected=observed[2],
            )
            if include:
                weights[mode] = fit(
                    samples[:, cols].ravel(),
                    np.tile(np.array([k == 2 for k in cols]), len(samples)),
                )
    # The paper reports a reversal timing deviation for one participant. Count AP and SP separately for transparency.
    payload = dict(
        source="Halder et al. 2026, Supplementary Figure S3, CC BY 4.0",
        doi="10.1038/s41598-026-50911-6",
        source_sha256=digest,
        units="paper's frontal FOOOF log alpha power",
        state_order=STATES,
        participants=6,
        grouped_leave_one_out=result,
        protocol_deviation="One participant received reversal before the sedated sample. See published protocol.",
    )
    (root / "results/awake-blockade-alpha-results.json").write_text(
        json.dumps(payload, indent=2)
    )
    (root / "results/awake-blockade-alpha-weights.json").write_text(
        json.dumps(
            dict(
                models=weights,
                required_features=payload["units"],
                endpoint="published protocol condition",
                threshold=0.5,
            ),
            indent=2,
        )
    )
    for k, v in result.items():
        print(k, v)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
