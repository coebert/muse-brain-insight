#!/usr/bin/env python3
"""Offline, paired sleep-deprivation research using pinned, verified EEG waveforms."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

import numpy as np
import requests
from scipy.stats import binomtest, wilcoxon
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

import discover as eeg


DATASET = "ds004902"
RELEASE = "1.0.8"
# Publisher's README defines session numbers by condition, regardless of acquisition order.
SESSIONS = {1: "normal_sleep", 2: "sleep_deprived"}
eeg.RELEASES[DATASET] = RELEASE


def read_pair(row, cache):
    participant = row["participant_id"]
    order = str(row["SessionOrder"]).strip()
    records = []
    try:
        for session in SESSIONS:
            stem = f"{participant}/ses-{session}/eeg/{participant}_ses-{session}_task-eyesopen_eeg"
            eeg.repo_asset(DATASET, stem + ".fdt", cache, is_wave=True)
            samples, hz = eeg.read_eeglab(eeg.repo_asset(DATASET, stem + ".set", cache, is_wave=True))
            features, retained, offered = eeg.extract(samples[:, int(2 * hz):], hz)
            records.append((features, retained, offered))
        return (participant, order, records), None
    except (ValueError, KeyError, IndexError, TypeError, OSError, requests.RequestException) as error:
        print(f"Excluded {participant}: {type(error).__name__}: {error}", flush=True)
        return None, type(error).__name__


def paired_auc(probabilities, seed):
    labels = np.tile([0, 1], len(probabilities))
    rng = np.random.default_rng(seed)
    bootstraps = [roc_auc_score(labels, probabilities[rng.integers(len(probabilities), size=len(probabilities))].ravel())
                  for _ in range(1500)]
    wins = int((probabilities[:, 1] > probabilities[:, 0]).sum())
    ties = int((probabilities[:, 1] == probabilities[:, 0]).sum())
    paired_ci = binomtest(wins, len(probabilities) - ties).proportion_ci()
    return {
        "auroc": float(roc_auc_score(labels, probabilities.ravel())),
        "auroc_ci95_paired_bootstrap": np.quantile(bootstraps, [0.025, 0.975]).tolist(),
        "pairs_ranked_correctly": wins,
        "pairs_tied": ties,
        "paired_ranking_ci95_excluding_ties": [paired_ci.low, paired_ci.high],
    }


def fit_models(features, names, fit, test, seed):
    specs = {
        "multichannel_standard": [i for i, feature in enumerate(names) if feature.split(".")[-1] in eeg.SIMPLE],
        "frontal_extended": [i for i, feature in enumerate(names) if feature.startswith("frontal.")],
        "multichannel_extended": list(range(len(names))),
    }
    models = {}
    labels = np.tile([0, 1], len(fit))
    for model_name, columns in specs.items():
        train_data = features[fit][:, :, columns].reshape(-1, len(columns))
        test_data = features[test][:, :, columns].reshape(-1, len(columns))
        pipe = make_pipeline(StandardScaler(), LogisticRegression(C=1, max_iter=1000))
        pipe.fit(train_data, labels)
        metrics = paired_auc(pipe.predict_proba(test_data)[:, 1].reshape(-1, 2), seed)
        scaler, classifier = list(pipe.named_steps.values())
        models[model_name] = {
            **metrics,
            "weights": {"features": [names[i] for i in columns], "mean": scaler.mean_.tolist(),
                        "scale": scaler.scale_.tolist(), "coefficients": classifier.coef_[0].tolist(),
                        "intercept": float(classifier.intercept_[0])},
        }
    return models


def parkinson_stress(features, names, previous):
    studies = json.loads(previous.read_text())["studies"]
    outcomes = []
    for study in studies:
        if "parkinson" not in study["task"].lower():
            continue
        for contrast in study["contrasts"]:
            model = contrast.get("models", {}).get("all_extended", {}).get("offline_model")
            if not model:
                continue
            columns = [names.index(name) for name in model["features"]]
            intercept = float(np.asarray(model["intercept"]).reshape(-1)[0])
            coef = np.asarray(model["coefficients"]).reshape(-1)
            margins = ((features[:, :, columns] - model["mean"]) / model["scale"]) @ coef + intercept
            delta = margins[:, 1] - margins[:, 0]
            outcomes.append({"target": contrast["target"], "pairs": len(delta),
                             "median_logit_change": float(np.median(delta)),
                             "logit_change_iqr": np.quantile(delta, [0.25, 0.75]).tolist(),
                             "increased": int((delta > 0).sum()),
                             "wilcoxon_p": float(wilcoxon(delta).pvalue)})
    return outcomes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    args = parser.parse_args()
    metadata = eeg.table(eeg.repo_asset(DATASET, "participants.tsv", args.cache))
    with ThreadPoolExecutor(max_workers=8) as workers:
        loaded = list(workers.map(lambda row: read_pair(row, args.cache), metadata.to_dict("records")))
    pairs = [pair for pair, _ in loaded if pair is not None]
    if len(pairs) < 40:
        raise RuntimeError(f"Expected at least 40 complete acceptable pairs, got {len(pairs)}")
    names = sorted(pairs[0][2][0][0])
    features = np.array([[[record[0][name] for name in names] for record in pair[2]] for pair in pairs])
    fit, test = train_test_split(np.arange(len(pairs)), test_size=0.3, random_state=eeg.RNG_SEED,
                                 stratify=[pair[1] for pair in pairs])
    assert set(fit).isdisjoint(test)
    result = {
        "dataset": DATASET, "release": RELEASE, "study": "Southwest University eyes-open sleep deprivation",
        "session_conditions": SESSIONS, "metadata_participants": len(metadata), "complete_pairs": len(pairs),
        "exclusions": dict(Counter(error for _, error in loaded if error)),
        "fit_participants": len(fit), "holdout_participants": len(test),
        "fit_order_counts": dict(Counter(pairs[i][1] for i in fit)),
        "holdout_order_counts": dict(Counter(pairs[i][1] for i in test)),
        "analyzed_seconds": 4 * sum(record[1] for pair in pairs for record in pair[2]),
        "offered_seconds": 4 * sum(record[2] for pair in pairs for record in pair[2]),
        "models": fit_models(features, names, fit, test, eeg.RNG_SEED),
        "parkinson_sleep_deprivation_stress": parkinson_stress(features, names, args.previous),
    }
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
