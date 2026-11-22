"""Deterministic features for 8 s, 125 Hz bipolar EEG, with disjoint derivations."""

import itertools
import numpy as np
from scipy import signal
from scipy.special import entr
from scipy.ndimage import uniform_filter1d

FS = 125
REGIONS = ["frontal", "central", "posterior"]
BANDS = [(1, 4), (4, 8), (8, 13), (13, 20), (20, 30)]
BASIC = ["log_delta", "log_theta", "log_alpha", "log_beta", "log_high_beta"]
EXTRA = [
    "alpha_burst_cv",
    "slow_alpha_coupling",
    "ordinal_fast_excess",
    "ordinal_slow_excess",
    "alpha_left_right_imaginary_coherence",
]
BASIC_NAMES = [f"{r}.{f}" for r in REGIONS for f in BASIC]
EXTRA_NAMES = [f"{r}.{f}" for r in REGIONS for f in EXTRA] + [
    "front_back.alpha_imaginary_coherence",
    "front_back.theta_imaginary_coherence",
    "front_back.alpha_envelope_correlation",
]
FILTERS = {
    k: signal.butter(3, b, fs=FS, btype="bandpass", output="sos")
    for k, b in [("slow", [1, 3]), ("alpha", [8, 13]), ("wide", [1, 30])]
}
PERMS = np.array(list(itertools.permutations(range(3))))


def ordinal(v, lag):
    seq = np.stack([v[:, : -2 * lag], v[:, lag:-lag], v[:, 2 * lag :]], axis=-1)
    order = np.argsort(seq, axis=-1, kind="stable")
    probs = np.array([(order == p).all(axis=-1).mean(axis=-1) for p in PERMS])
    return entr(probs).sum(axis=0) / np.log(6)


def phase_surrogate(v, seed):
    rng = np.random.default_rng(seed)
    ft = np.fft.rfft(v)
    ph = rng.uniform(-np.pi, np.pi, size=ft.shape)
    ph[:, [0, -1]] = 0
    return np.fft.irfft(ft * np.exp(1j * ph), n=v.shape[1])


def analyse_window(v):
    if v.shape != (6, 1000):
        raise ValueError("Expected two bilateral derivations for each of three regions")
    if (
        not np.isfinite(v).all()
        or np.any(np.ptp(v, axis=1) < 1)
        or np.any(np.ptp(v, axis=1) >= 1200)
    ):
        return None
    v = signal.detrend(v.astype(float), axis=1)
    f, _, z = signal.stft(
        v, fs=FS, window="hann", nperseg=250, noverlap=125, boundary=None, padded=False
    )
    power = (np.abs(z) ** 2).mean(axis=-1)
    basic = np.stack(
        [
            np.log(np.maximum(power[:, (f >= lo) & (f < hi)].sum(axis=1), 1e-15))
            for lo, hi in BANDS
        ],
        axis=1,
    )

    def ico(i, j, band):
        mask = (f >= band[0]) & (f < band[1])
        cross = (z[i, mask] * z[j, mask].conj()).mean(axis=1)
        return np.abs(cross.imag).sum() / max(
            np.sqrt(power[i, mask] * power[j, mask]).sum(), 1e-15
        )

    analytic = {
        k: signal.hilbert(signal.sosfiltfilt(s, v, axis=1), axis=1)[:, 125:-125]
        for k, s in FILTERS.items()
    }
    env = np.abs(analytic["alpha"])
    unit = np.exp(1j * np.angle(analytic["slow"]))
    cv = env.std(axis=1) / np.maximum(env.mean(axis=1), 1e-12)
    coupling = np.abs(
        ((env - env.mean(axis=1, keepdims=True)) * unit).mean(axis=1)
    ) / np.maximum(env.std(axis=1), 1e-12)
    wide = analytic["wide"].real
    diffs = []
    sur = [phase_surrogate(wide, s) for s in (134, 821, 1776)]
    for lag in [1, 4]:
        diffs.append(ordinal(wide, lag) - np.mean([ordinal(a, lag) for a in sur], axis=0))
    extra = np.stack([cv, coupling, *diffs], axis=1).reshape(3, 2, 4).mean(axis=1)
    bilateral = np.array([ico(k, k + 1, (8, 13)) for k in (0, 2, 4)])
    regions = np.column_stack([extra, bilateral]).ravel()
    long = [np.mean([ico(k, k + 4, band) for k in (0, 1)]) for band in [(8, 13), (4, 8)]]
    smooth = uniform_filter1d(env, size=31, axis=1)[:, 15:-15]
    corrs = [np.corrcoef(smooth[k], smooth[k + 4])[0, 1] for k in (0, 1)]
    out = np.r_[basic.reshape(3, 2, 5).mean(axis=1).ravel(), regions, long, np.mean(corrs)]
    return out if np.isfinite(out).all() else None


def summarize(windows, limit=None):
    # Equalise the amount of waveform available in the two propofol sites per run.
    if limit is not None and len(windows) > limit:
        windows = windows[np.linspace(0, len(windows) - 1, limit, dtype=int)]
    rows = [v for x in windows if (v := analyse_window(x)) is not None]
    if len(rows) < 2:
        return None, len(rows)
    return np.median(rows, axis=0), len(rows)
