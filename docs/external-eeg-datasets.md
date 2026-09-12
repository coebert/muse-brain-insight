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

### Found in the latest survey (Tier 1 additions)

| Source | Content | Access / licence | Status in app |
| --- | --- | --- | --- |
| **OpenNeuro ds005620** — repeated-awakening propofol study | 21 volunteers, 65-channel EEG with repeatedly probed responsiveness during target-controlled propofol; awakening/unresponsive events per cycle | CC0, direct download | **Registered** — the `openneuro-ds005620` intake source replays the BrainVision recordings and pairs the condition intervals as depth-state references |
| **OpenNeuro ds006695** — UCSD forehead patch sleep | 3-channel **frontal** patch EEG — the closest published montage yet to the headband form factor | CC0, direct download | Documented only: recordings are EEGLAB `.set`/`.fdt`, which the current EDF/BrainVision parsers do not read; needs a small `.fdt` parser or offline conversion to CSV/EDF before intake |

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

### Found in the latest survey (Tier 2 additions)

- **BDSP — Burst Suppression of Deep Hypothermia** (`bdsp.io`, study
  `dhypothermia`) — continuous EEG from cardiac-surgery patients cooled for
  deep-hypothermic circulatory arrest; expert-reviewed burst/suppression
  annotations. Real burst suppression from a *non-anaesthetic* aetiology — a
  genuinely independent ground truth for the suppression model alongside
  I-CARE. Access: free **BDSP account** (open-access tier, registration
  required; no public anonymous file index). Intake is registered in the
  pathology-datasets panel as a manual CSV upload (`bdsp-dhypothermia`).
- **BDSP `bsupp` — real-time burst-suppression segmentation** — critical-care
  EEG with expert-segmented burst and suppression intervals, published to
  evaluate a real-time segmentation algorithm. Ideal for scoring the
  suppression detector against human raters. Access: **restricted** — named
  credentialed user, cannot be automated.
- **Bitbrain BOAS (OpenNeuro ds005555)** — 128 nights of **simultaneous
  gold-standard PSG and a wearable frontal headband** (ZMax-style), EDF with
  per-30 s sleep-stage events for both montages. Not anaesthesia, but the only
  public corpus pairing a consumer headband with a clinical montage on the same
  head at the same time — directly usable for headband-vs-clinical
  harmonisation validation. Access: open, EDF format the intake already reads;
  sleep-stage labels would need their own labelling path (they are not
  anaesthesia states), so this is queued as future work rather than wired in.

## Reference algorithms (not data)

- **OpenBSR** — Connor, *Anesthesia & Analgesia* 2024 (open access on PMC, code
  published). A freely published burst-suppression-ratio algorithm validated
  against the BIS monitor's own SR. Use: cross-check the app's suppression-ratio
  detector against OpenBSR on a stored burst-suppression lineage and report the
  agreement on the suppression dashboard — an independent algorithmic reference
  that needs no data licence.
- **Propofol-vs-sevoflurane drug-signature paper** (medRxiv 2024) — published
  spectral signatures, no data files; worth folding into the drug-signature
  library as literature-derived priors.

## How each would be used

1. **COEBIS priors** — VitalDB BIS + age/sex/regimen fits the population tier of
   the hierarchical model; local paired readings stay the personalising layer.
2. **Suppression validation** — I-CARE, `eeg-gaba-anesthesia` and now BDSP
   hypothermia give real burst suppression to score the suppression-ratio
   detector against, replacing part of the synthetic validation pack; BDSP
   adds a non-anaesthetic aetiology so the detector cannot overfit to
   propofol-shaped suppression.
3. **Seizure detector** — TUSZ/CHB-MIT as an external test set (re-referenced to
   a frontal bipolar montage approximating the device) for sensitivity and
   false-alarms-per-hour, reported separately from the synthetic pack.
4. **Artefact rejection** — TUAR labelled chew/muscle/electrode artefacts to
   tune the EMG and artefact gates.
5. **Depth-state grading** — ds005620 responsiveness intervals grade the
   depth-state classifier on repeated within-subject awakenings (a harder test
   than a single induction→emergence arc).

## Constraints to respect

- Restricted PhysioNet sets require a named credentialed user and a signed DUA;
  they cannot be redistributed inside the app or bundled into shipped models.
- BDSP open-access data still requires a personal BDSP account; downloads are
  manual and the converted files enter through the pathology-datasets panel
  with their own lineage.
- Montage mismatch is the main scientific risk: scalp 10-20 clinical EEG is not
  a frontal 1–4 channel headband. Re-reference to Fp1/Fp2-derived bipolars and
  band-limit to the device bandwidth before any fitting, and label the resulting
  model version as externally-derived.
- Any model fitted on external data must remain visible in the lineage/versioning
  UI so a clinician can see the estimate is not purely their own case history.

## Cambridge propofol sedation (Chennu et al.)

Healthy volunteers recorded at baseline, mild and moderate target-controlled
propofol, and again in recovery, with a behavioural task recording whether they
still responded at each level. High-density 91-channel EGI, average reference,
250 Hz.

Value here: the label is a person responding or not, not another monitor's
number, so it grades the depth index against what depth is meant to mean.

Intake: Data exchange → "Cambridge propofol sedation (Chennu)". One file per
volunteer per level, either signal samples or published power spectra; the
level and behavioural verdict for the block are set at import. Stored under
lineage `external:cambridge:chennu-propofol-sedation`, outside headband
alignment, and read by the responsiveness fit on COEBIS → Calibration.
Sedated-but-responsive blocks are stored as responsive, never as awake.
