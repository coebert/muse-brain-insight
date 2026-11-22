"""Research-only adult resting EEG age estimator. All amplitudes must be microvolts."""

import argparse
import json
from pathlib import Path
import numpy as np
from scipy import signal

REGIONS = ["frontal", "central", "posterior"]
BANDS = [(1, 4), (4, 8), (8, 13), (13, 20), (20, 30)]
MEASURES = [
    "log_delta_fraction",
    "log_theta_fraction",
    "log_alpha_fraction",
    "log_low_beta_fraction",
    "log_high_beta_fraction",
    "log_total_power",
    "spectral_slope",
    "alpha_peak_hz",
    "alpha_prominence_db",
]
NAMES = [f"{region}.{measure}" for region in REGIONS for measure in MEASURES]
MONTAGE = ["Fp1-F7", "Fp2-F8", "F3-C3", "F4-C4", "P3-O1", "P4-O2"]


def features(windows):
    x = np.asarray(windows, dtype=float)
    if x.ndim != 3 or x.shape[1:] != (6, 1000):
        raise ValueError("Expected eight-second windows, six bipolar channels, 125 Hz")
    amplitude = np.ptp(x, axis=2)
    ok = np.isfinite(x).all(axis=(1, 2)) & ((amplitude > 1) & (amplitude < 350)).all(axis=1)
    if ok.sum() < 4:
        return None
    f, psd = signal.welch(x[ok], 125, nperseg=500, noverlap=250, detrend="linear")
    spec = np.median(psd, axis=0).reshape(3, 2, -1).mean(axis=1)
    output = []
    for p in spec:
        total = p[(f >= 1) & (f < 30)].sum()
        out = [np.log(p[(f >= lo) & (f < hi)].sum() / total) for lo, hi in BANDS]
        mask = ((f >= 2) & (f <= 6)) | ((f >= 15) & (f <= 25))
        slope, intercept = np.polyfit(np.log(f[mask]), np.log(p[mask]), 1)
        band = (f >= 7) & (f <= 13)
        residual = 10 / np.log(10) * (np.log(p[band]) - intercept - slope * np.log(f[band]))
        peaks, props = signal.find_peaks(residual, prominence=2)
        if len(peaks):
            pos = int(np.argmax(residual[peaks]))
            freq = f[band][peaks[pos]]
            prominence = props["prominences"][pos]
        else:
            freq, prominence = np.nan, 0.0
        output += out + [np.log(total * 0.25), slope, freq, prominence]
    return np.array(output)


def score(windows, model, state, montage, sample_rate, unit, reference_age_eligible=False):
    if reference_age_eligible is not True:
        return {"status": "outside or unknown reference age range"}
    if (state, montage, sample_rate, unit) != ("awake_rest_eyes_closed", MONTAGE, 125, "uV"):
        return {"status": "unsupported acquisition"}
    if len(windows) != 6:
        return {"status": "requires 48 seconds"}
    feat = features(windows)
    if feat is None:
        return {"status": "insufficient usable EEG"}
    z = (np.where(np.isfinite(feat), feat, model["impute"]) - model["mean"]) / model["scale"]
    prediction = float(np.dot(z, model["coef"]) + model["intercept"])
    half = model["interval_half_width"]
    return {
        "status": "research_only",
        "EEG_age_years": prediction,
        "reference_prediction_interval_90pct": [prediction - half, prediction + half],
        "reference_age_range": model["age_range"],
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    for key in ["input", "weights", "metadata"]:
        p.add_argument(key)
    args = p.parse_args()
    with np.load(args.input, allow_pickle=False) as inp:
        print(
            json.dumps(
                score(
                    inp["x"],
                    json.loads(Path(args.weights).read_text()),
                    **json.loads(Path(args.metadata).read_text()),
                )
            )
        )
