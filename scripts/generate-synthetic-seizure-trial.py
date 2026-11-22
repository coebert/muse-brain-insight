"""Regenerate the bundled synthetic feature fixture with the original MindGuard seizure study.
Usage: python scripts/generate-synthetic-seizure-trial.py /path/to/extracted/study
Requires the study's Python dependencies. Does not read any fitted model or human data.
"""
import base64
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(sys.argv[1]) / "src"))
from detector import design
from waveforms import features

hz = 256
seconds = 192
t = np.arange(seconds * hz) / hz
rng = np.random.default_rng(107020)
signals = []
for channel in range(2):
    x = (13 * np.sin(2 * np.pi * (9.7 + channel * 0.4) * t + 0.3 * channel)
         + 5 * np.sin(2 * np.pi * 2.2 * t) + rng.normal(0, 2, len(t)))
    event_t = np.clip(t - 64, 0, 64)
    phase = 2 * np.pi * (3.5 * event_t + 0.020 * event_t ** 2)
    x += ((t >= 64) & (t < 128)) * (1 - 0.34 * channel) * (
        34 * np.sin(phase) + 14 * np.sin(2 * phase) + 6 * np.sin(3 * phase))
    if channel == 1:
        x[(t >= 144) & (t < 160)] = 0
    signals.append(x)
wave = np.stack(signals + [np.full_like(t, np.nan)] * 6)
rows, usable = design(features(wave, hz), "frontal", 8)
assert rows.shape == (24, 140)
fixture = dict(usable=usable.tolist(), data=base64.b64encode(rows.astype("<f4").tobytes()).decode("ascii"))
path = Path(__file__).resolve().parents[1] / "src/lib/eeg/synthetic-seizure-features.json"
path.write_text(json.dumps(fixture, separators=(",", ":")) + "\n")
