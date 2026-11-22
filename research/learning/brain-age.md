# EEG age in MindGuard

22 November 2026 · Offline research model · Adult resting EEG

The target is chronological age. Physiological brain age has no independent reference measurement in this analysis. The fitted estimator quantifies how strongly a short EEG resembles those of different ages in the Dortmund reference cohort.

## Accuracy

| Cohort | People | Ages (years) | Mean absolute error, years (95% interval) | Training-median error | Spearman correlation | Mean signed error, years |
|---|---:|---|---|---:|---:|---:|
| Dortmund, five-fold held-out participants | 490 | 20.0 to 70.0 | 10.0 (9.4 to 10.6) | 12.9 | 0.59 | 0.0 |
| Oslo, frozen external test | 76 | 20.0 to 69.0 | 8.7 (7.2 to 10.5) | 12.5 | 0.44 | -0.9 |
| Athens, frozen external test | 14 | 57.0 to 70.0 | 18.6 (14.5 to 23.3) | 18.6 | -0.18 | -18.6 |

The frozen estimator used 392 Dortmund participants for fitting and a separate 98 for calibration. The nominal 90% split-conformal interval is ±20.2 years. It contained the true age in 91% of eligible Oslo controls and 57% of eligible Athens controls. The Greek sample spans a narrow age range. A local leave-one-out median achieves 2.6 years MAE there and 11.5 in Oslo. These local benchmarks use ages from the respective external cohort. No external cohort data were used to fit the EEG model. Predictions systematically compress the age range. The slope of predicted against actual age was 0.34 in Dortmund and 0.26 in Oslo.

## How the waveform changes

The table shows the features with the same direction and Benjamini–Yekutieli adjusted p < 0.05 in both Dortmund and Oslo, among 27 features per cohort. All correlations are cross-sectional and unadjusted for sex. Relative powers share a denominator. The three regional derivations are bilateral averages, and the slope uses natural log power against natural log frequency. All associations, detection counts, slopes per decade and Dortmund decade medians are in the aggregate JSON.

| Regional feature | Dortmund age correlation | Oslo age correlation |
|---|---:|---:|
| Central background spectral slope | 0.34 | 0.44 |

The median central slope was −0.87 in participants aged 20–29, −0.81 at 30–39, −0.69 at 40–49, −0.64 at 50–59 and −0.50 at 60–70. A less negative value means power falls more slowly as frequency rises. This frequency-band summary does not establish a cellular mechanism.

The posterior alpha peak also slowed in Dortmund, from a median 10.0 Hz in the twenties to 9.5 Hz at ages 60–70; its age correlation was −0.23. In Oslo the correlation was −0.07 and failed the replication criterion. The portion of posterior power in the alpha band declined in Dortmund but showed no consistent trend in Oslo. An alpha-only clock would therefore have weak support across these cohorts.

## Error by age and sex in held-out Dortmund participants

Positive signed error means the EEG estimate is older than chronological age. Strata with fewer than five people are omitted.

| Group | People | Mean signed error (years) | Mean absolute error (years) |
|---|---:|---:|---:|
| 20-29 | 110 | 12.3 | 12.3 |
| 30-39 | 92 | 7.4 | 8.3 |
| 40-49 | 92 | -0.9 | 6.0 |
| 50-59 | 103 | -6.4 | 8.5 |
| 60-69 | 81 | -13.1 | 13.6 |
| 70 only | 12 | -20.0 | 20.0 |
| F | 316 | 1.0 | 10.1 |
| M | 174 | -1.8 | 9.8 |

## Does it measure ageing within a person?

Among 157 people with good-quality recordings at both visits, the mean elapsed time was 5.2 calendar years. The model estimated a mean change of 2.5 years (participant-bootstrap 95% interval 1.6 to 3.4). The middle 80% of individual changes ranged from -4.0 to 9.0 years. The estimate increased in 69% of people. Each pair was scored by a model that had seen neither visit. Differences in recording year provide integer-year elapsed times.

In Oslo, the age gap was compared with two independent cognitive measures after adjusting for age, age squared and sex, with multiplicity correction across the two tests. The partial correlations were -0.06 for delayed verbal recall (adjusted p=0.903) and 0.18 for time on letter trail-making (adjusted p=0.409). These cross-sectional tests cannot establish physiological age or predict decline.

In a deliberate out-of-domain challenge on 20 Cambridge participants, moving from baseline to the moderate propofol protocol stage shifted the model output by a median absolute 14.4 years within the same person. This quantifies state sensitivity. The replay rejects sedation and unconfirmed recording states.

## Data accounting

Of 608 Dortmund baseline participants, 517 had a qualifying source recording and 490 passed the waveform quality criteria. We decoded 198 follow-up visits and obtained 157 eligible baseline–follow-up pairs. Of 111 Oslo recordings, 86 passed waveform criteria and 76 also met the reference age range. Of 29 Athens controls, 22 passed waveform criteria and 14 also met the age range. Attrition and the narrow age range at Athens limit generalisability.

## Signal processing and comparisons

The analysis selected eyes-closed, pre-task Dortmund recordings with zero source-flagged late triggers, first-visit Oslo eyes-closed recordings and healthy Athens controls. It excluded outside-reference ages from external age accuracy. It used seconds 4–52 of the EDFs, six non-overlapping eight-second windows and a 125 Hz common sampling rate. Greek controls used the matching early block. Windows were rejected for nonfinite samples or a peak-to-peak range outside (1,350) µV on any derivation. At least four of six windows had to survive. This simple amplitude gate cannot confirm wakefulness, exclude every artifact or correct differences in acquisition.

The model uses Fp1–F7, Fp2–F8, F3–C3, F4–C4, P3–O1 and P4–O2. It estimates regional spectra using four-second Hann windows; features include five relative band powers, total power, background spectral slope and prominence and frequency of a discernible alpha peak. Missing peaks are imputed using training medians. A fixed ridge regression (penalty 35) uses 27 EEG features. Age, sex and cognition are excluded from its inputs. One row per participant entered development; all transformations were fitted within training folds. Participant bootstrap intervals use 2,000 resamples and do not capture model refitting uncertainty.

Using only frontal features gave MAE 12.2 years in Dortmund and 11.7 in Oslo. Using only the band powers and total power yielded 10.4 and 8.9 years respectively. The frontal pairs in this comparison do not reproduce a particular commercial headband.

## Offline replay and reproduction

Run from the research/learning directory. Install the existing research dependencies plus pandas and requests. Run age_metadata.py, then age_extract.py. To include both challenge cohorts, run extract_dementia_temporal.py with the current directory as its argument, and extract_temporal.py with the arguments cambridge and raw-cambridge. Create the temporal-results directory and run validate_brain_age.py followed by check_brain_age.py. Intermediate files stay local.

For replay, run `python brain_age.py recording.npz temporal-results/brain-age-weights.json acquisition.json`. The NPZ field x must contain six consecutive windows, six derivations in the documented order and 1,000 samples per window. Acquisition metadata must specify state `awake_rest_eyes_closed`, montage (ordered list), sample_rate 125, unit `uV` and reference_age_eligible true (known to be in the reference age range). Never use the age of the participant to adjust the output. The score and interval are research outputs. The model has no established application during anaesthesia or to diagnosis, treatment or screening decisions.

## Source releases

- [Dortmund adult lifespan recordings and five-year follow-up, ds005385 v1.0.2](https://doi.org/10.18112/openneuro.ds005385.v1.0.2)
- [Oslo SRM resting EEG, ds003775 v1.2.1](https://doi.org/10.18112/openneuro.ds003775.v1.2.1)
- [Athens resting EEG, ds004504 v1.0.9](https://doi.org/10.18112/openneuro.ds004504.v1.0.9)
- Cambridge propofol study source and decoding are documented in [the waveform research report](README.md).
- [Aggregate results](temporal-results/brain-age-results.json) and [fitted weights](temporal-results/brain-age-weights.json).
