# Public EEG / DSA data sources for COEBIS and diagnostic models

Candidate external corpora that could enlarge the training pool. Every source
below is a *different acquisition lineage* to a Muse 2 or bridge headband
(different electrodes, reference, sampling rate, amplifier bandwidth), so any
use must go through the existing lineage machinery: import as its own
`source_lineage`, fit tier-level priors only, and never let it silently
back-fill a device-specific model.

## Tier 1 — anaesthesia depth (directly relevant to COEBIS)

| Source | Content | Access / licence |
| --- | --- | --- |
| VitalDB (PhysioNet + vitaldb.net) | 6,388 surgical cases, 196 intraoperative parameters incl. **BIS index, SEF, SR, EMG** numerics and (subset) raw BIS/SedLine waveforms, plus age/sex/ASA, propofol/remifentanil dosing | Open, free API + Python lib; CC-BY style, registration-free |
| PhysioNet `eeg-gaba-anesthesia` | SedLine 250 Hz frontal EEG through propofol/sevoflurane induction→burst suppression, incl. controlled-infusion volunteer | PhysioNet Contributor Review licence (credentialing) |
| PhysioNet `eeg-power-anesthesia` | Multitaper spectra + conscious/unconscious labels, 10 volunteers + 44 OR cases (propofol / sevo / mixed) — effectively ready-made DSA | Restricted: credentialed + DUA |
| DOSE-I (Zenodo) | 171 procedural-sedation endoscopy recordings, 2-channel fronto-temporal EEG @125 Hz + propofol dosing, 78.5 h | Open on Zenodo |

VitalDB is the single highest-value source: it is the only large open set that
pairs commercial BIS with covariates and drug regimen, i.e. exactly the shape of
`bis_paired_points`. It has no raw frontal EEG for most cases, so it can train
the **BIS↔covariate/regimen prior** layer, not the raw-signal front end.

## Tier 2 — ICU sedation, coma and burst suppression

- **I-CARE / PhysioNet Challenge 2023** — continuous ICU EEG after cardiac
  arrest, hours per patient, with outcome labels; rich in burst suppression and
  suppression-ratio ground truth.
- **TUH EEG Corpus (TUEG)** — 26,846 clinical recordings; subsets **TUSZ**
  (seizure onsets/types), **TUEV** (spike/sharp, GPED, PLED), **TUAR**
  (eye/chew/shiver/muscle/electrode artefacts). Free after signing the request
  form (rsync/ssh key).
- **CHB-MIT Scalp EEG** — 23 paediatric cases, 198 annotated seizures, fully
  open (ODC-BY).

## How each would be used

1. **COEBIS priors** — VitalDB BIS + age/sex/regimen fits the population tier of
   the hierarchical model; local paired readings stay the personalising layer.
2. **Suppression validation** — I-CARE and `eeg-gaba-anesthesia` give real burst
   suppression to score the suppression-ratio detector against, replacing part
   of the synthetic validation pack.
3. **Seizure detector** — TUSZ/CHB-MIT as an external test set (re-referenced to
   a frontal bipolar montage approximating the device) for sensitivity and
   false-alarms-per-hour, reported separately from the synthetic pack.
4. **Artefact rejection** — TUAR labelled chew/muscle/electrode artefacts to
   tune the EMG and artefact gates.

## Constraints to respect

- Restricted PhysioNet sets require a named credentialed user and a signed DUA;
  they cannot be redistributed inside the app or bundled into shipped models.
- Montage mismatch is the main scientific risk: scalp 10-20 clinical EEG is not
  a frontal 1–4 channel headband. Re-reference to Fp1/Fp2-derived bipolars and
  band-limit to the device bandwidth before any fitting, and label the resulting
  model version as externally-derived.
- Any model fitted on external data must remain visible in the lineage/versioning
  UI so a clinician can see the estimate is not purely their own case history.
