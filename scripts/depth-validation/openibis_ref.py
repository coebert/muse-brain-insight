"""Faithful NumPy port of openibis.m (Connor CW, Anesth Analg 2022)."""
import numpy as np
from scipy.signal import butter, lfilter

FS, STRIDE = 128, 0.5
NSTRIDE = int(FS * STRIDE)

def baseline(x):
    n = len(x)
    v = np.vstack([np.ones(n), np.arange(1, n + 1)]).T
    coef, *_ = np.linalg.lstsq(v, x, rcond=None)
    return v @ coef

def segment(eeg, frm, number, nstride=NSTRIDE):
    s = int(round(frm * nstride))
    return eeg[s:s + int(number * nstride)]

def n_epochs(eeg):
    return int(np.floor((len(eeg) - FS) / NSTRIDE) - 10)

def movmean_trailing(x, k):
    out = np.empty(len(x))
    c = np.cumsum(np.concatenate([[0.0], x]))
    for i in range(len(x)):
        lo = max(0, i - k + 1)
        out[i] = (c[i + 1] - c[lo]) / (i + 1 - lo)
    return out

def suppression(eeg):
    N = n_epochs(eeg)
    bsrmap = np.zeros(N)
    for n in range(1, N + 1):
        x = segment(eeg, n + 6.5, 2)
        bsrmap[n - 1] = 1.0 if np.all(np.abs(x - baseline(x)) <= 5) else 0.0
    return bsrmap, 100 * movmean_trailing(bsrmap, int(63 / STRIDE))

def psd_of(x):
    w = np.blackman(len(x))
    f = np.fft.fft(w * (x - baseline(x)))
    n = len(x)
    return 2 * np.abs(f[:n // 2]) ** 2 / (n * np.sum(w ** 2))

def band(frm, to, bins=0.5):
    return np.arange(int(round(frm / bins)), int(round(to / bins)) + 1)

def mean_band_power(psd_rows, frm, to):
    v = psd_rows[:, band(frm, to)]
    v = v[~np.isnan(v)]
    return np.mean(10 * np.log10(v))

def prctmean(x, lo, hi):
    x = x[~np.isnan(x)]
    a, b = np.percentile(x, [lo, hi])
    return np.mean(x[(x >= a) & (x <= b)])

def trimmean(x, pct):
    x = np.sort(x[~np.isnan(x)])
    k = int(np.floor(len(x) * pct / 100 / 2))
    return np.mean(x[k:len(x) - k]) if len(x) - 2 * k > 0 else np.mean(x)

def log_power_ratios(eeg, bsrmap):
    N = n_epochs(eeg)
    B, A = butter(2, 0.65 / (FS / 2), 'high')
    hp = lfilter(B, A, eeg)
    psd = np.full((N, 4 * NSTRIDE // 2), np.nan)
    comps = np.full((N, 3), np.nan)
    for n in range(1, N + 1):
        if not (n < 4 or np.any(bsrmap[max(0, n - 4):n])):
            psd[n - 1, :] = psd_of(segment(hp, n + 4, 4))
        rng = np.arange(max(0, n - int(30 / STRIDE)), n)
        sub = psd[rng, :]
        if np.all(np.isnan(sub)):
            continue
        with np.errstate(invalid='ignore'):
            vhigh = np.sqrt(np.nanmean(sub[:, band(39.5, 46.5)] * sub[:, band(40, 47)], axis=1))
            whole = np.sqrt(np.nanmean(sub[:, band(0.5, 46.5)] * sub[:, band(1, 47)], axis=1))
            mid = prctmean(np.nanmean(10 * np.log10(sub[:, band(11, 20)]), axis=0), 50, 100)
            comps[n - 1, 0] = mean_band_power(sub, 30, 47) - mid
            comps[n - 1, 1] = trimmean(10 * np.log10(vhigh / whole), 50)
            comps[n - 1, 2] = mean_band_power(sub, 0.5, 4) - mid
    return comps

def piecewise(x, xp, yp):
    return np.interp(np.clip(x, xp[0], xp[-1]), xp, yp)

def scurve(x, eo, emax, x50, xwidth):
    return eo - emax / (1 + np.exp((x - x50) / xwidth))

def mixer(comps, bsr):
    sedation = scurve(comps[:, 0], 104.4, 49.4, -13.9, 5.29)
    general = piecewise(comps[:, 1], [-60.89, -30], [-40, 43 - 1])
    general = general + scurve(comps[:, 1], 61.3, 72.6, -24.0, 3.55) * (comps[:, 1] >= -30)
    bsr_score = piecewise(bsr, [0, 100], [50, 0])
    gw = piecewise(comps[:, 2], [0, 5], [0.5, 1]) * (general < sedation)
    bw = piecewise(bsr, [10, 50], [0, 1])
    x = sedation * (1 - gw) + general * gw
    return piecewise(x, [-40, 10, 97, 110], [0, 10, 97, 100]) * (1 - bw) + bsr_score * bw

def openibis(eeg):
    bsrmap, bsr = suppression(eeg)
    return mixer(log_power_ratios(eeg, bsrmap), bsr), bsr
