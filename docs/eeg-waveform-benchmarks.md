# External EEG waveform benchmarks

These benchmarks fit and evaluate small research models on published EEG. The Admin → Training replay panel is isolated from clinical workflows. Its outputs are comparisons for the exact recording formats defined below. The scores do not participate in live monitoring or alarms.

## Reproduce

Use Python 3.12. Install the versions listed in [the training workflow](../.github/workflows/eeg-research-baseline.yml). Run `python research/eeg/train.py seizures` or `python research/eeg/train.py bis`. The run downloads waveform files to scratch, extracts features, preserves source-specific attribution and records the fit/test split and metrics. No patient recordings belong in Git. For the DOSE-I responsiveness study, first review the data use agreement and the research purpose, then run `python research/eeg/train.py responsiveness` in the permitted environment. That task writes aggregate metrics only.

| Task | Model and input |
| --- | --- |
| Seizure-window discrimination | Logistic regression using 4-second FP1–F7 and FP2–F8 EEG snippets, at 256 or 512 Hz. Threshold is estimated from calibration patients and kept fixed for the test patients. The published weights missed most positive windows. |
| BIS agreement | Ridge regression using each 5-second single-channel Figshare EEG window, based on the 125 Hz and 5-second BIS cadence inferred from the matching sample counts. |
| Responsiveness | DOSE-I Logistic regression using two EEG channels from 8 seconds before a bedside assessment, leaving a 2-second gap immediately before the label. The benchmark compares MOAA/S 1–2 with 4–5, excluding the intermediate score. |

The fits use Hann-tapered spectral features, spectral entropy and edge frequency, RMS and line length. The replay panel takes a single JSON object with `hz`, `channels`, `samples` (an array of sample arrays in the same channel order), `units` and `timedAndGapFree`. Its exact waveform checks and finite-value guards are in `scoreResearchWindow`. Clinical recordings need their own intended use, hardware validation and appropriately governed storage.

## Sources and attribution

- Shoeb A. **CHB-MIT Scalp EEG Database**, v1.0.0, PhysioNet. Open Data Commons Attribution Licence 1.0. Seizure annotations and EEG data were used, with the CHB-21 repeat of CHB-01 omitted and windows separated by patient. [Source and licence](https://physionet.org/content/chbmit/1.0.0/) · [DOI 10.13026/C2K01R](https://doi.org/10.13026/C2K01R)
- Detti P. **Siena Scalp EEG Database**, v1.0.0, PhysioNet. CC BY 4.0. Waveforms were re-referenced where needed to match the published bipolar benchmark derivations. [Source and licence](https://physionet.org/content/siena-scalp-eeg/1.0.0/) · [DOI 10.13026/5d4a-j060](https://doi.org/10.13026/5d4a-j060)
- **EEG and BIS raw data**, Figshare record 5589841. CC BY 4.0. EEG vectors were converted to spectral and time-domain features, then fit against the matched BIS vectors. [Source and licence](https://figshare.com/articles/dataset/EEG_and_BIS_raw_data/5589841)
- Garbe J et al. **DOSE-I**, Zenodo release 22145442. The portal includes a separate data use agreement. This benchmark reports aggregate results and does not include the fitted DOSE-I coefficients. [Source and agreement](https://zenodo.org/records/22145442) · [DOI 10.5281/zenodo.22145442](https://doi.org/10.5281/zenodo.22145442)

[Seizure benchmark](https://github.com/coebert/muse-brain-insight/actions/runs/44742714112) · [BIS benchmark](https://github.com/coebert/muse-brain-insight/actions/runs/44742955983) · [Replay tests and app build](https://github.com/coebert/muse-brain-insight/actions/runs/44743925387)
