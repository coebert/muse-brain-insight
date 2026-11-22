"""Check waveform replay against fitted coefficients and acquisition guards."""

import json
from pathlib import Path
import numpy as np
from brain_age import score, features, MONTAGE
from validate_brain_age import fit, array, cohort, SEED
from sklearn.model_selection import train_test_split


def main():
    weights = json.loads(Path("temporal-results/brain-age-weights.json").read_text())
    ids, y, _, x = array(cohort("ds005385", "ses-1"))
    fit_ids, _ = train_test_split(
        np.arange(len(y)), test_size=0.20, stratify=np.minimum(y // 10, 6), random_state=SEED
    )
    model = fit(x[fit_ids], y[fit_ids])
    meta = dict(
        state="awake_rest_eyes_closed",
        montage=MONTAGE,
        sample_rate=125,
        unit="uV",
        reference_age_eligible=True,
    )
    for p in sorted(Path("age-raw/ds003775").glob("*.npz")):
        with np.load(p) as z:
            data = z["x"]
        if features(data) is not None:
            break
    out = score(data, weights, **meta)
    assert np.isclose(out["EEG_age_years"], model.predict(features(data)[None, :])[0])
    assert score(data * 0, weights, **meta)["status"] == "insufficient usable EEG"
    for key, value in [
        ("state", "sedated"),
        ("unit", "V"),
        ("sample_rate", 250),
        ("montage", MONTAGE[::-1]),
        ("reference_age_eligible", False),
    ]:
        assert "EEG_age_years" not in score(data, weights, **{**meta, key: value})
    print(
        "Verified frozen-model parity, signal quality, age range, recording state, unit, rate and montage guards."
    )


if __name__ == "__main__":
    main()
