# MindGuard EEG disease-pattern discovery

21 November 2026

The programme processed resting EEG from **391 participants** across four released cohorts, including 109 in the secondary technical check. The primary extraction yielded **5 hours 7 minutes** of analysable EEG in four-second windows. An additional 25 Parkinson’s participants contributed paired medication-state recordings from their second visit. The models were trained and evaluated offline. No participant waveforms, identifiers or per-patient predictions are embedded in the app.

## Results

| Group comparison | Participants in discovery | Within-cohort AUROC, extended model (95% interval) | External check |
| --- | ---: | --- | --- |
| Alzheimer’s disease vs controls | 65 | **0.82** (0.72–0.92), standard spectral comparator 0.81 | Cejnek technical check, 20 Alzheimer’s and 86 controls. Extended model **0.62** (0.46–0.77), standard spectral comparator **0.71** (0.56–0.83). The different source formats make this a biased validation cohort. |
| Frontotemporal dementia vs controls | 52 | **0.70** (0.55–0.84), standard spectral comparator 0.71 | Independent cohort unavailable in this pass. |
| Alzheimer’s disease vs frontotemporal dementia | 59 | **0.64** (0.48–0.77), standard spectral comparator 0.46 | Independent cohort unavailable in this pass. No individual feature passed multiplicity correction. |
| Parkinson’s disease vs controls | 50 | **0.68** (0.54–0.83), standard spectral comparator 0.69 | Independent Tel Aviv cohort, 116 Parkinson’s and 28 controls. Extended model **0.49** (0.37–0.62), standard spectral comparator **0.45** (0.32–0.59). |

[Completed dementia analysis](https://github.com/coebert/muse-brain-insight/actions/runs/44912732282/job/136871777423) · [Completed Parkinson’s analysis](https://github.com/coebert/muse-brain-insight/actions/runs/44912732282/job/136871777853)

## What the waveforms showed

- **Shared dementia patterns.** Posterior slowing and lower central waveform ordinal entropy were associated with both dementia groups after adjustment for age and sex. In the age- and sex-adjusted AHEPA analyses, central ordinal entropy was lower by 0.73 pooled standard deviations in Alzheimer’s disease and 0.89 in frontotemporal dementia versus controls, with within-contrast adjusted q-values of 0.00050 and 0.042. These are associations with clinical study groups. Spectral differences can influence ordinal entropy.
- **An Alzheimer’s hypothesis that travelled partly.** Posterior theta power was higher in the Alzheimer’s group in both the AHEPA analysis and Cejnek technical check. Central theta also changed in the same direction. The held-out Cejnek comparisons were unadjusted for age and sex because the relevant demographic covariates were unavailable. Of 86 controls scored, 84 used the separate 22-row control archive format. The 20 Alzheimer’s records came from the 19-channel export format. An additional 3 participants with mild cognitive impairment passed waveform screening and were excluded from this binary contrast.
- **Disease specificity was weak.** Central variability in slowing had the strongest unadjusted Alzheimer’s-versus-frontotemporal association. Its adjusted q-value was 0.71. The frontal-only extended models produced 0.77 for Alzheimer’s versus control and 0.35 for Alzheimer’s versus frontotemporal dementia within AHEPA. The broader montages performed better on those tasks in this cohort. Direct testing of the intended electrode placements remains necessary.
- **Parkinson’s performance did not transfer.** No discovery feature passed the corrected threshold, and the trained multivariable model was near chance in Tel Aviv. Higher posterior theta showed the same direction in both cohorts, but the discovery q-value was 0.34. Posterior theta remains an exploratory lead. The 25 paired on/off medication recordings had no feature passing q ≤ 0.10.
- **No new biomarker was established.** Existing reviews describe EEG slowing and spectral or complexity differences in neurodegenerative conditions. This experiment identifies which candidates merit a fairer test and which fitted models failed to generalise. [Neurodegenerative EEG review](https://www.nature.com/articles/s44400-026-00089-5) · [Parkinson’s quantitative EEG review](https://pmc.ncbi.nlm.nih.gov/articles/PMC13721006/)

## Cohorts and intended comparisons

| Source | Role and recording conditions |
| --- | --- |
| AHEPA, OpenNeuro ds004504 v1.0.9 | Eyes-closed clinical scalp EEG from 36 people with Alzheimer’s disease, 23 with frontotemporal dementia and 29 controls. Discovery for three group contrasts. |
| Cejnek, Figshare 5450293 v1 | Secondary technical transfer check for Alzheimer’s disease. The archive uses different export layouts for most controls and the Alzheimer’s group. Sampling rate was matched at 128 Hz for this check, but format, acquisition and missing demographic covariates still limit interpretation. |
| New Mexico, OpenNeuro ds003490 v1.1.0 | 25 people with Parkinson’s disease and 25 controls. Eyes-open rest events for the main comparison, using the on-medication visit for cases. Separate paired analysis of the off-medication visit. |
| Tel Aviv, OpenNeuro ds007526 v1.0.2 | Independent eyes-open seated resting EEG from 116 people with Parkinson’s disease and 28 controls. The model was fitted in New Mexico and scored here using the same features and training scaling. |

[Dataset descriptor for AHEPA](https://doi.org/10.3390/data8060095) · [Cejnek data and licence](https://doi.org/10.6084/m9.figshare.5450293.v1) · [New Mexico data](https://doi.org/10.18112/openneuro.ds003490.v1.1.0) · [Tel Aviv data](https://doi.org/10.18112/openneuro.ds007526.v1.0.2)

The original archive files were obtained through their release routes and checked against OpenNeuro’s tagged annex keys or Figshare’s file checksum. The six scalp derivations cover frontal (FP1–F7, FP2–F8), central (F3–C3, F4–C4) and posterior (P3–O1, P4–O2) regions. These are scalp comparisons and do not represent a Muse 2 validation. The Cejnek reader uses the published analysis order with separate 19-channel export and 22-row control layout handling, and clips each source segment to a whole number of four-second epochs before assembly. Channel-order assumptions and dataset-specific differences are additional limits on that check. [Cejnek reader reference](https://github.com/zarishabbas/EEG_audio/blob/main/1-preprocessing_equalise_sessions.ipynb)

## Methods

1. Take up to 48 seconds of EEG per participant, split into four-second windows, and reject windows with nonfinite, flat or unusually high peak-to-peak amplitude relative to the participant’s sample. These filters are a basic quality screen. No electrode fault, muscle artefact or eye movement adjudication was performed.
2. Summarise 44 measurements per participant, including bandpower, slowing, spectral entropy, a spectral-slope proxy, temporal variability, left–right differences, phase-lag measures, alpha peak and ordinal waveform entropy. Run age- and sex-adjusted feature screens when both covariates are available. Within each discovery contrast use Benjamini–Hochberg correction, with up to eight candidates taken forward at q ≤ 0.10. Where none reach that threshold, report up to three exploratory leads.
3. Fit fixed regularised linear and nonlinear models. Compare frontal and broader scalp montages and standard spectral features against the extended feature set. Fit feature scaling on each training fold only. Five-fold internal predictions are held out by participant. External performance uses the model fitted on the entire discovery cohort and scores it on the independent source. Test shortlisted features with Holm correction. Recurrence in the Cejnek technical check does not qualify as independent replication.
4. AUROC intervals come from stratified participant bootstrap resampling of the scored set. They do not capture variability from repeating the full pipeline at a new hospital. Preserve coherent label definitions and source provenance when expanding the pool.

[EEG data leakage analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC11099244/) · [AHEPA benchmark review](https://doi.org/10.1007/s11571-026-10464-w)

## Reproduction and integration

Run the [discovery workflow](https://github.com/coebert/muse-brain-insight/blob/research/eeg-baselines/.github/workflows/eeg-disease-discovery.yml) or run `research/discovery/discover.py` with task `dementia` or `parkinson`, setting `--cache` to local scratch and `--output` to a JSON path. The [aggregate results and fitted parameters](https://github.com/coebert/muse-brain-insight/blob/research/eeg-baselines/docs/eeg-disease-discovery-results.json) include feature order, fitted coefficients and feature scaling for offline comparisons. Decision scores are uncalibrated.

MindGuard’s **Admin → Training → EEG disease-pattern research** panel presents aggregate results, the comparison model and the original run. There is no browser-based patient prediction in this panel.

The catalogue’s 194 entries include rights-restricted cohorts, overlapping releases, non-waveform resources, sleep and artefact data, and cohorts without relevant disease labels. This experiment used the four cohorts listed above. The patient count measures these analyses and should not be extrapolated to the rest of the catalogue.
