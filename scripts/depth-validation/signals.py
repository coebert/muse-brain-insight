"""Synthetic frontal EEG at 256 Hz for defined anaesthetic states."""
import numpy as np

FS = 256

def _osc(n, f, amp, rng, jitter=0.15):
    ph = np.cumsum(2 * np.pi * (f * (1 + jitter * rng.standard_normal(n) * 0.02)) / FS)
    return amp * np.sin(ph)

def state_signal(state, seconds, rng):
    n = int(seconds * FS)
    t = np.arange(n) / FS
    x = np.zeros(n)
    if state == "awake":
        x += _osc(n, 10, 12, rng) + _osc(n, 20, 9, rng) + _osc(n, 32, 6, rng)
        x += 4 * rng.standard_normal(n)          # EMG-ish broadband
    elif state == "sedated":
        x += _osc(n, 10, 20, rng) + _osc(n, 16, 7, rng) + _osc(n, 2, 12, rng)
        x += 2.0 * rng.standard_normal(n)
    elif state == "ga":
        x += _osc(n, 10, 28, rng) + _osc(n, 1.2, 30, rng) + _osc(n, 5, 8, rng)
        x += 1.0 * rng.standard_normal(n)
    elif state == "deep":
        x += _osc(n, 0.8, 40, rng) + _osc(n, 3, 10, rng) + _osc(n, 9, 6, rng)
        x += 0.6 * rng.standard_normal(n)
    elif state == "burst_suppression":
        x += _osc(n, 1.0, 45, rng) + _osc(n, 8, 12, rng) + 0.5 * rng.standard_normal(n)
        env = np.zeros(n)
        k = 0
        while k < n:
            burst = int(rng.uniform(0.8, 1.6) * FS)
            supp = int(rng.uniform(3.0, 7.0) * FS)
            env[k:k + burst] = 1.0
            k += burst + supp
        x = x * env + 0.4 * rng.standard_normal(n) * (1 - env)
    elif state == "isoelectric":
        x += 0.3 * rng.standard_normal(n)
    return x

SESSIONS = [
    ("emergence_ramp", [("deep", 120), ("ga", 180), ("sedated", 150), ("awake", 120)]),
    ("induction_ramp", [("awake", 120), ("sedated", 120), ("ga", 180), ("deep", 150)]),
    ("steady_ga", [("ga", 420)]),
    ("bs_episode", [("ga", 150), ("burst_suppression", 240), ("ga", 150)]),
    ("icu_deep_sedation", [("sedated", 180), ("deep", 240), ("sedated", 120)]),
    ("cardiac_arrest", [("burst_suppression", 180), ("isoelectric", 180), ("deep", 120)]),
]

def build_session(spec, seed):
    rng = np.random.default_rng(seed)
    parts = [state_signal(s, sec, rng) for s, sec in spec]
    return np.concatenate(parts)
