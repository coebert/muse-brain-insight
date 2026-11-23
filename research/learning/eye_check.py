"""Awake eyes-open negative control for the independently trained Cambridge state model."""

import json
from pathlib import Path
import sys
import numpy as np
from fit_state import load, summarize, train, scores


def run(root, out):
    sources = {k: load(root, k) for k in ["cambridge", "oslo"]}
    files = list((root / "cache-eye-control").glob("*.npz"))
    if len(files) < 12:
        raise ValueError("incomplete eye-control collection")
    for p in files:
        with np.load(p) as f:
            sources["oslo"][(p.stem.split("-")[0], "eyes_open")] = {
                "runs": [f["x"]],
                "correct": None,
            }
    result = {}
    for montage in ("frontal", "broader"):
        training = summarize(sources["cambridge"], "cambridge", montage)
        model = train(training)
        oslo = summarize(sources["oslo"], "oslo", montage)
        paired = []
        for pid in sorted({r["pid"] for r in oslo}):
            conditions = {r["state"]: r for r in oslo if r["pid"] == pid}
            if {"baseline", "eyes_open", "sedated"} <= set(conditions):
                paired.append(
                    scores([conditions[k] for k in ("baseline", "eyes_open", "sedated")], model)
                )
        if len(paired) < 5:
            raise ValueError("too few complete eye-state controls")
        vals = np.stack(paired)
        delta = vals[:, 1] - vals[:, 0]
        boot = np.random.default_rng(618).choice(delta, (2500, len(delta)), replace=True)
        result[montage] = {
            "participants": len(delta),
            "mean_open_minus_closed": float(delta.mean()),
            "mean_change_participant_bootstrap_95": np.percentile(
                boot.mean(1), [2.5, 97.5]
            ).tolist(),
            "above_half_while_awake_EC": int(sum(vals[:, 0] >= 0.5)),
            "above_half_while_awake_EO": int(sum(vals[:, 1] >= 0.5)),
            "above_half_pre_awakening": int(sum(vals[:, 2] >= 0.5)),
            "median_score_EC_EO_sedated": np.median(vals, axis=0).tolist(),
        }
    out.mkdir(parents=True, exist_ok=True)
    (out / "propofol-eye-control.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    run(Path(sys.argv[1]), Path(sys.argv[2]))
