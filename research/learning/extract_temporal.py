"""Recover bipolar 125 Hz waveform windows with the existing study decoders."""

from pathlib import Path
import sys
import numpy as np
import sedation


def windows(x, hz):
    if hz != 125 or x.shape[0] != 6 or x.shape[1] % 1000:
        raise ValueError("Expected complete 8-second, six-derivation windows at 125 Hz")
    return x.reshape(6, -1, 1000).transpose(1, 0, 2).astype("float32")


if __name__ == "__main__":
    site = sys.argv[1]
    dest = Path(sys.argv[2])
    dest.mkdir(exist_ok=True, parents=True)
    sedation.features = windows
    if site == "cambridge":
        sedation.cambridge(dest)
    elif site in ("oslo", "oslo-eyes-open"):
        sedation.oslo(dest, eyes_open_only=site.endswith("open"))
    else:
        raise ValueError(site)
