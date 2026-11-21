# MindGuard EEG source expansion

21 November 2026

The [source catalogue](../research/eeg/source-catalogue.csv) now holds 238 records. This pass adds 30 entries and updates access and overlap notes for three existing source families. Entries EEG-209–238 contain 26 waveform sources listed by repositories or dataset authors, one credentialed umbrella archive with an unverified unique file count and three leads with pending access or file verification. Counts on the catalogue describe the relevant deposit or study. No new waveforms were ingested or used to retrain a model in this pass.

## Directly useful acquisitions

| Source | Scale or design | Research value and access |
| --- | --- | --- |
| [ASZED-153](https://zenodo.org/records/14178398) | 153 Nigerian recordings from two sites, including 76 participants with schizophrenia and 77 controls | Public 207.7 MB archive. Independent scalp EEG clinical cohort. Retain the original diagnostic classes and resting/task distinctions. |
| [DCSM](https://doi.org/10.17894/ucph.282d3c1e-9b98-4c1e-886e-704afdfa9179) | 255 sleep-lab recordings with EDF and hypnograms | Public university archive. Useful for sleep-state and montage robustness. |
| [ANPHY-Sleep](https://doi.org/10.17605/OSF.IO/R26FH) | 29 high-density overnight scalp EEG studies | Public OSF deposit. Enables full-montage versus reduced-montage comparisons. |
| [Cognitive overload and rest](https://www.nemar.org/dataset/on008302) | 124 adults with 64-channel raw EEG, ECG, PPG and eye tracking. The deposit is 202 GB and includes auxiliary data. | CC0. Tests state and cognitive workload confounding. Download subject-specific subsets during feasibility checks. |
| [Driving fatigue](https://doi.org/10.6084/m9.figshare.28455737) | 50 participants in a two-hour simulator protocol with concurrent biosignals | Raw deposit. Compare fatigue labels with non-EEG information where possible, since EEG contributed to clinical annotation. |
| [ELUCID](https://bdsp.io/content/5sgi7wp4ubz4dufty5jk/1.0.0/) | 24-channel overnight scalp EEG in late-onset epilepsy. Seven-site enrolment target is 600 adults aged 55+. | Credentialed incremental release. Confirm the current EEG and diagnostic metadata manifest before counting available records. |

## Scope and overlap

The new NSRR entries include Wisconsin, STAGES, APPLES, CCSHS, HomePAP, ABC, APOE and the Mignot PSG release. NSRR requires approved access under study-specific use agreements. Match patient and site provenance before combining Mignot recordings with separate releases from the same sleep clinics. [NSRR access policy](https://sleepdata.org/about/data-security) · [Cross-cohort sleep source table](https://pmc.ncbi.nlm.nih.gov/articles/PMC13722680/)

The Moody Challenge 2026 training data provide a curated access route to a Human Sleep Project subset with raw EDF, human annotations and cognitive labels. The source is already recorded under the parent family. MORGOTH is a companion release to the Harvard clinical EEG resource, and the Healthy Brain Network numbered releases and mirrors are listed under one family. The two multicentre invasive epilepsy releases may share patients, so their independence needs to be established before treating either as an external test. [Moody Challenge](https://moody-challenge.physionet.org/2026/) · [MORGOTH](https://bdsp.io/content/morgoth1/1.0.0/) · [Healthy Brain Network](https://github.com/OpenNeuroDatasets/ds005516)

Use sleep, workload and sensor-task recordings for waveform pretraining or robustness tests. Preserve task-specific ground truth in separate supervised work. In particular, sleep-stage, disease and intraoperative responsiveness labels describe different endpoints. The additional search did not verify a new public intraoperative reference cohort with raw waveforms and behavioural responsiveness annotations.
