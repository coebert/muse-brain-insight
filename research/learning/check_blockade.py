"""Specific regression checks for known/suspected blockade and public figure extraction."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import numpy as np
from blockade_challenge import low_features
from replay import score


def main():
    root = Path(__file__).parent
    r = json.loads((root / "results/awake-blockade-alpha-results.json").read_text())
    assert r["participants"] == 6
    assert "figure_derived_participant_medians" not in r
    for mode in r["grouped_leave_one_out"].values():
        for counts in mode.values():
            assert "held_out_scores" not in counts
            assert all(
                0 <= counts[k] <= 6
                for k in ("awake_blockade_false_sedated", "propofol_protocol_detected")
            )
    # A drop confined to high-frequency power multiplies all relative low bands by one common factor.
    e = np.ones((2, 2, 13))
    e[..., 1:4] = [0.12, 0.11, 0.19]
    other = e.copy()
    other[..., 1:4] *= 1.75
    assert np.allclose(low_features(e), low_features(other))
    with TemporaryDirectory() as td:
        p = Path(td) / "signal.npz"
        hz = 125
        time = np.arange(hz * 32) / hz
        x = np.stack([20 * np.sin(2 * np.pi * 8 * time), 14 * np.sin(2 * np.pi * 9 * time)])

        def save(x):
            np.savez(p, unit="uV", hz=hz, derivations=["FP1-F7", "FP2-F8"], waveforms=x)

        save(x)
        for exposure in ["documented", "suspected", "unknown", "reported-absent"]:
            out = score("propofol", "frontal", p, root / "results", exposure)
            assert out["consciousness_inference"] is None
            assert out["blockade_context"] == exposure
            assert out["propofol_protocol_state_score"] is None
        save(0 * x)
        assert (
            score("propofol", "frontal", p, root / "results", "documented")["status"]
            == "insufficient usable EEG"
        )
    print(
        "Verified descriptor-only replay, low-band ratios, cohort counts and aggregate-only results."
    )


if __name__ == "__main__":
    main()
