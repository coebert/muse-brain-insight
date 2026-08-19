# Seizure detector validation pack

Synthetic labelled vignettes scored through the live `EegAnalyzer` at the
shipped detection settings. Regenerate with `bunx vitest run seizure-validation`.

- Sensitivity: 100 % (3/3 ictal vignettes)
- Specificity: 80 % (4/5 non-ictal vignettes)
- False alarms per hour: 396.0 over 0.333 h of non-ictal recording

| Vignette | Truth | Length | Verdict | Alert epochs | Peak score | First alert (s) |
| --- | --- | --- | --- | --- | --- | --- |
| Evolving rhythmic 3→5 Hz ictal run, ICU sedation | ictal | 180 s | alert | 100 | 0.979 | 80 |
| High-amplitude spike-and-wave, 3 Hz with harmonics | ictal | 120 s | alert | 78 | 0.899 | 42 |
| Late-onset 4 Hz seizure after a quiet baseline | ictal | 240 s | alert | 74 | 0.979 | 166 |
| Sustained frontal EMG (light plane, jaw tension) | non-ictal | 180 s | no alert | 0 | 0.618 | — |
| Rhythmic chewing / ventilator artefact at 1.6 Hz | non-ictal | 180 s | no alert | 0 | 0.378 | — |
| Propofol maintenance: frontal alpha over delta | non-ictal | 300 s | no alert | 0 | 0.36 | — |
| Deep sedation: monotonous 1 Hz delta | non-ictal | 300 s | no alert | 0 | 0.392 | — |
| Burst suppression, 40 % suppressed | non-ictal | 240 s | alert | 132 | 0.662 | 18 |

These are shaped synthetic traces, not human recordings: they bound detector
behaviour against known patterns and artefacts, and are not evidence of clinical
sensitivity in patients.
