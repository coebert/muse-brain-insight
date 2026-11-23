"""Test a frozen Parkinson EEG score for sensitivity to medication within the same person."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import re
from pathlib import Path
import tempfile
import sys

import numpy as np
import pandas as pd
import pyedflib
import requests
from scipy.special import expit
from scipy.stats import wilcoxon

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "discovery"))
from discover import repo_asset, RELEASES, bipolar, extract, download


def run(cache, weights, out):
    ds = "ds002778"
    RELEASES[ds] = "1.0.5"
    studies = json.loads(weights.read_text())["studies"]
    m = next(r for r in studies if r["task"] == "parkinson")["contrasts"][0]["models"]
    m = m["all_extended"]["offline_model"]
    people = pd.read_csv(repo_asset(ds, "participants.tsv", cache), sep="\t")
    people = people[people.participant_id.str.startswith("sub-pd")]

    def visit(pid, state, checkout):
        prefix = f"{pid}/ses-{state}/eeg/{pid}_ses-{state}_task-rest"
        channels = pd.read_csv(repo_asset(ds, prefix + "_channels.tsv", checkout), sep="\t")
        use = {"FP1", "FP2", "F7", "F8", "F3", "F4", "C3", "C4", "P3", "P4", "O1", "O2"}
        available = {
            str(row["name"]).upper()
            for _, row in channels.iterrows()
            if str(row["status"]).lower() == "good"
        }
        if not use <= available:
            raise ValueError("missing or flagged electrode")
        rel = prefix + "_eeg.bdf"
        pointer = repo_asset(ds, rel, checkout / "pointer").read_text()
        key = re.search(r"(SHA256|MD5)E?-s(\d+)--([a-f0-9]+)", pointer)
        if key is None:
            raise ValueError("unknown pinned BDF pointer")
        p = download(
            f"https://s3.amazonaws.com/openneuro.org/{ds}/{rel}", checkout / (state + ".bdf")
        )
        if (
            p.stat().st_size != int(key[2])
            or hashlib.new(key[1].lower(), p.read_bytes()).hexdigest() != key[3]
        ):
            raise ValueError("BDF differs from tagged release")
        with pyedflib.EdfReader(str(p)) as f:
            names = [s.strip().upper() for s in f.getSignalLabels()]
            names_use = []
            vv = []
            hz = None
            for name in sorted(use):
                if names.count(name) != 1:
                    raise ValueError("ambiguous electrode")
                idx = names.index(name)
                rate = int(f.getSampleFrequency(idx))
                if hz is not None and hz != rate:
                    raise ValueError("mixed sample rates")
                if f.getPhysicalDimension(idx).lower().replace("µ", "u").replace("μ", "u") != "uv":
                    raise ValueError("units")
                hz = rate
                vv.append(f.readSignal(idx, 30 * hz, 48 * hz))
                names_use.append(name)
        x, kept, offered = extract(bipolar(vv, names_use), hz)
        score = float(
            expit(
                ((np.array([x[k] for k in m["features"]]) - m["mean"]) / m["scale"])
                @ m["coefficients"]
                + m["intercept"]
            )
        )
        return score, kept

    def person(record):
        if "preprocessed" in str(record["notes"]).lower():
            return None, "source identifies substituted preprocessed data"
        try:
            with tempfile.TemporaryDirectory(dir=cache) as tmp:
                on = visit(record["participant_id"], "on", Path(tmp))
                off = visit(record["participant_id"], "off", Path(tmp))
                return [on, off], None
        except (ValueError, OSError, KeyError, requests.RequestException) as e:
            return None, str(e).split("http")[0][:75]

    with ThreadPoolExecutor(max_workers=4) as pool:
        rr = list(pool.map(person, people.to_dict("records")))
    paired = [x for x, reason in rr if x]
    issues = dict(Counter(reason for x, reason in rr if reason))
    if len(paired) < 4:
        raise ValueError(f"Only {len(paired)} pairs: {issues}")
    on = np.array([a[0] for a, b in paired])
    off = np.array([b[0] for a, b in paired])
    d = on - off
    boot = np.random.default_rng(709).choice(d, (3000, len(d)), replace=True)
    result = {
        "source": "OpenNeuro ds002778 v1.0.5",
        "target": "Change in frozen New Mexico Parkinson research score, medication ON minus OFF in the same person.",
        "eligible_raw_pairs": len(d),
        "offered_patients": len(people),
        "exclusions": issues,
        "seconds_used": int(sum((a[1] + b[1]) * 4 for a, b in paired)),
        "median_on_minus_off": float(np.median(d)),
        "mean_on_minus_off": float(d.mean()),
        "mean_delta_participant_bootstrap_95": np.quantile(boot.mean(1), [0.025, 0.975]).tolist(),
        "paired_wilcoxon_two_sided_p": float(wilcoxon(d).pvalue),
        "median_absolute_change": float(np.median(abs(d))),
        "score_higher_on_medication": int(sum(d > 0)),
        "notes": "Small paired sensitivity experiment. No healthy-control diagnosis test, dose-time reference or treatment recommendation. Scores are uncalibrated.",
    }
    out.mkdir(exist_ok=True, parents=True)
    (out / "parkinson-medication-check.json").write_text(
        json.dumps(result, indent=2, allow_nan=False) + "\n"
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("cache", type=Path)
    p.add_argument("frozen_results", type=Path)
    p.add_argument("output", type=Path)
    a = p.parse_args()
    a.cache.mkdir(exist_ok=True, parents=True)
    run(a.cache, a.frozen_results, a.output)
