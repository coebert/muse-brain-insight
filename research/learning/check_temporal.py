"""Focused checks of time ordering, source boundaries and spectral controls."""

import numpy as np
from temporal_features import analyse_window, phase_surrogate
from temporal_features import BASIC_NAMES, EXTRA_NAMES
from seizure_history import add_history
from temporal_study import estimate, prob, serialize
from scipy.special import expit

rng = np.random.default_rng(8)
x = rng.normal(size=(6, 1000)) * 10
assert np.allclose(abs(np.fft.rfft(phase_surrogate(x, 701))), abs(np.fft.rfft(x)))
out = analyse_window(x)
assert len(out) == len(BASIC_NAMES) + len(EXTRA_NAMES) and np.isfinite(out).all()
assert analyse_window(x * 0) is None
x[1, 3] = np.nan
assert analyse_window(x) is None
v = rng.normal(size=(50, 104))
valid = np.ones(50, bool)
valid[13] = False
r = {"usable": valid, "x": v}
h = add_history(r)["x"]
v2 = v.copy()
v2[30:] *= 1e3
assert np.allclose(h[:30], add_history({**r, "x": v2})["x"][:30])
assert np.all(h[14, 104:] == 0)
xx = rng.normal(size=(22, 6))
yy = np.tile([0, 1], 11)
fit = estimate(xx, yy)
weights = serialize(fit, list("abcdef"))
manual = expit(
    (xx - weights["mean"]) / weights["scale"] @ weights["coef"] + weights["intercept"]
)
assert np.allclose(manual, prob(fit, xx))
print(
    "PASS: spectrum-preserving surrogate, feature count, invalid inputs, past-only context, gap reset, and frozen-weight replay"
)
