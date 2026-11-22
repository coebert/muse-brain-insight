# Neuromuscular blockade and the awake EEG

MindGuard research analysis, 21 November 2026

A depth monitor must cope with a conscious person losing skeletal muscle activity. We evaluated a documented awake-paralysed condition directly. In participant-held-out testing, the model still labelled one of six awake, paralysed volunteers as sedated. The research replay now abstains from interpreting depth when given documented or suspected blockade. These models have no established clinical awareness sensitivity.

## Training on published awake-paralysed measurements

Halder and colleagues recorded six participants before cisatracurium, during awake paralysis and during a subsequent propofol sedation protocol. The investigators retained an isolated forearm during the awake challenge. The authors report that awareness in the sedated condition could not be objectively verified. They also document that one participant received reversal before the sedated EEG was acquired. We retained that case under its reported protocol label. [Article and availability statement](https://pmc.ncbi.nlm.nih.gov/articles/PMC13612226/) · [Supplement, Figure S3](https://media.springernature.com/full/springer-static/esm/art%3A10.1038%2Fs41598-026-50911-6/MediaObjects/41598_2026_50911_MOESM1_ESM.pdf)

From Figure S3 we extracted the vector positions of 18 white median markers, calibrated each panel against its three y-axis ticks, and checked the ordering against the labelled panels. Each value summarises frontal log alpha power from 47 overlapping epochs. This yielded three measurements per volunteer. Counting the epochs as separate volunteers would substantially overstate the evidence. The feature is specific to the paper's frontal region, referencing and spectral fit. Attribution for the adapted measurements is to Halder et al., Scientific Reports (2026), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

We fit class-balanced logistic comparators with fixed regularisation and threshold 0.5. Each of the six validation rounds kept every measurement from one person out of training and scaling. The personalised model used that person's own pre-block awake EEG as its reference at inference. The awake baseline itself therefore provides no independent discrimination test in that model. The absolute model required no personal baseline. Neither fitting method used BIS as a target.

| Model | Awake-paralysed people falsely called sedated | Propofol-protocol states classified as sedated |
|---|---:|---:|
| Absolute frontal alpha, trained with awake blockade | 1/6 | 5/6 |
| Change from own awake baseline, trained with awake blockade | 1/6 | 6/6 |
| Change from own awake baseline, omitted awake blockade in training | 1/6 | 6/6 |

Including the awake-paralysed measurements did not reduce the observed awake-paralysis error. Choice of alpha was informed by this same paper. Independent validation requires a different cohort. [Extraction and training](awake_blockade_fit.py) · [Aggregate held-out results](results/awake-blockade-alpha-results.json)

## A separate awake rocuronium example

Schuller et al. studied ten awake volunteers with suxamethonium and rocuronium, using an isolated forearm to communicate. The public supplement is a two-page PDF containing three images from one volunteer. The captions distinguish the awake pre-block tracing, awake paralysis and the subsequent propofol dose. We verified the captions and all three images. The PDF contains no embedded acquisition files. The subsequent GE Entropy study replayed acquired signals and provides another device comparison. Avoid counting its repeated playbacks as additional independent volunteers. [BIS study](https://pubmed.ncbi.nlm.nih.gov/26174308/) · [Published tracing images](https://ars.els-cdn.com/content/image/1-s2.0-S0007091217310152-mmc1.pdf) · [Entropy study](https://pubmed.ncbi.nlm.nih.gov/37879777/)

We also fit a separate propofol comparator on Cambridge and Oslo recordings using only log theta/delta and alpha/delta ratios. The shared broadband power denominator cancels, so a change confined to higher-frequency power cannot change these ratios mathematically. Real EEG can change at lower frequencies too. The two-frontal-derivation AUROCs were 0.82 training in Cambridge and testing in Oslo, and 0.80 in the reverse direction. The six-derivation values were 1.00 and 0.90, with only 35% sensitivity at 0.5 in Cambridge for this version. These results concern protocol state across two small cohorts.

An exploratory check of the published screenshots found that a frontal low-band feature projection still shifted during awake paralysis. The images have limited resolution, unknown absolute gain, and a duration below the replay requirement. The traces overlapped after propofol. We treated the illustration as qualitative evidence and excluded it from the model fits and cohort accuracy estimates. [Low-band comparator training](blockade_challenge.py) · [Between-centre results](results/blockade-challenge-results.json)

## Raw surgical waveforms and muscle activity

We screened the VitalDB public track directory for cases containing two 128 Hz frontal EEG waveforms, frontal monitor EMG, signal quality, and rocuronium infusion rate and volume. There were 264 cases with all six tracks. Of these, 32 contained a qualifying sustained rate transition after a low-rate observation period. All 32 were attempted. Fourteen lacked confirmation from the volume track and one lacked sufficient clean EEG. Seventeen contributed 476 non-overlapping eight-second windows for a separate research fit. Inputs were log band powers from both BIS channels. The target was the monitor's reported EMG in dB. Each case stayed within one fold for testing. [VitalDB data, Lee and Jung, CC BY 4.0](https://physionet.org/content/vitaldb/1.0.0/) · [Track names, units and rates](https://vitaldb.net/dataset/)

The case-averaged absolute error predicting monitor EMG was 1.21 dB, compared with 1.22 dB using a training-case mean. The 95% participant-resampled interval for improvement was −0.30 to +0.32 dB. Fourteen cases had at least four analysable windows either side. Their median post-minus-pre EMG change was +0.04 dB (interquartile range −0.07 to +0.19). These were infusion-rate changes during surgery. Previous boluses, depth of block, concurrent anaesthetic changes, and consciousness were unverified. Pump exposure therefore did not supply an awake-paralysed or unconscious label. The monitor EMG target shares the EEG electrodes, so it also cannot independently validate muscle activity or consciousness. [Screening, extraction and EMG training](rocuronium_waveforms.py) · [Results](results/rocuronium-surgical-results.json) · [Research-only EMG coefficients](results/rocuronium-emg-weights.json)

## Other sources and routes to the original recordings

| Resource | Available material | Appropriate use |
|---|---|---|
| Halder / Flinders six-volunteer study | Public participant-specific alpha summary and other figures. The authors offer de-identified original recordings on reasonable request, subject to institutional and ethics approvals. | Independent EEG reprocessing with common montages once access is granted. |
| Schuller / Cairns volunteer study | Public illustrated example. The original recordings existed and were replayed. A downloadable native participant series was not verified. | Request numerically sampled EEG, trial markers and reuse terms directly from the investigators. |
| Whitham et al., 2007, and Porr's Zenodo resource | Digitised post-paralysis power spectra from two people. These are frequency summaries. | Mechanistic reference for high-frequency muscle contamination. [Original study](https://www.sciencedirect.com/science/article/abs/pii/S1388245707001988) · [Digitised spectra](https://zenodo.org/records/7038831) |
| Whitham et al., Brain Topography | Article reporting scalp recordings in five volunteers before and after full neuromuscular paralysis. | Additional source for an access enquiry. Possible participant overlap with other Flinders experiments must be resolved before splitting by cohort. [Study](https://pubmed.ncbi.nlm.nih.gov/19229605/) |

A [draft investigator request](blockade-data-access.md) covers both research groups. For an access enquiry, request de-identified native voltages, sampling rates, electrode locations/reference, calibration, EEG/EMG synchronisation, signal-quality flags, drug and reversal timestamps, quantitative neuromuscular measurements where recorded, and timed responses to commands. Ask explicitly about research training, commercial device development, independent verification, and whether participants overlap another release. The next direct test is a locked, independent comparison of false sedation during confirmed awake paralysis and detection of actual sedative transitions while block is held constant.

## Replay and verification

The propofol research replay accepts an independently supplied blockade context. With documented or suspected blockade it returns interpretable spectral descriptors and an explicit abstention. All contexts leave consciousness inference unset. It never infers drug administration from EEG. Published alpha models accept the study's frontal spectral feature only; applying their coefficients to arbitrary headband alpha power is unsupported.

```sh
cd research/learning
python awake_blockade_fit.py .
python blockade_challenge.py .
python rocuronium_waveforms.py .
python check_blockade.py
python replay.py propofol frontal session.npz --blockade documented
```

For the other required cohort caches, see the [waveform training report](README.md). Model results and source hashes are included with the [research artifacts](results/SHA256SUMS). The public volunteer images were used locally for analysis and are linked at source.
