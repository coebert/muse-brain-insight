# Resting EEG age generalisation

25 November 2026. Offline research on estimation of chronological age. Source benchmark and frozen weights are pinned to commit 2e3a6974d93d8b93ebd6f1ba15a4a4edbafb4a63.

## Evidence from the original release

| Cohort | Participants | Full MAE (years) | Two frontal derivations MAE (years) | Frozen 90% interval observed coverage |
|---|---:|---:|---:|---:|
| Dortmund, participant-held-out | 490 | 10.0 | 12.2 | Not reported |
| Oslo | 76 | 8.7 | 11.7 | 69/76 (90.8%, exact 95% CI 81.9–96.2%) |
| Athens | 14 | 18.6 | 21.6 | 8/14 (57.1%, exact 95% CI 28.9–82.3%) |

MAEs are from the original aggregate JSON. Exact binomial confidence intervals are new calculations from the published counts. The nominal frozen interval was 40.4 years wide.

Predicted-on-observed slopes of 0.34 in Dortmund and 0.26 in Oslo quantify compression even before considering Athens. In ages 60–69, mean signed error was −13.1 years in Dortmund (81 participants) and −20.8 in Oslo (six). Shrinkage from regularisation and incomplete information about age are plausible contributors. Their individual contributions require controlled comparisons. The central background spectral slope showed the same age association in Dortmund and Oslo, whereas posterior alpha peak frequency did not meet the replication criterion.

Athens participants were aged 57–70 and mean signed error was −18.6 years. The model essentially tied the Dortmund training-median benchmark (18.6 years). The within-Athens leave-one-out median MAE was 2.6 years, which describes the narrow age distribution using target-cohort labels. Comparing the older strata suggests age mix alone may be insufficient to explain the transfer failure, but small samples, different age distributions within strata and different acquisition and population characteristics prevent attribution. Eight of 22 controls passing the waveform gate were outside reference age bounds. Coverage estimates apply to the 14 eligible controls.

## Implemented comparison

From research/learning, prepare the pinned Dortmund, Oslo and Athens files using the extraction instructions in brain-age.md, without regenerating the published frozen weights. Then run:

```sh
python -m unittest -v test_compare_eeg_age
python compare_eeg_age.py temporal-results/age-comparison.json
```

The comparison requires the published eligible counts and checks frozen external MAE and interval hit counts before writing aggregate JSON. It uses one baseline recording per participant. Five Dortmund outer folds stratify by decade. Within each fold, separate participant subsets fit preprocessing/model, fit affine point recalibration, and fit conformal radii. The external fits use Dortmund only. External labels are used for eligibility and scoring. Published frozen weights are evaluated externally because some Dortmund participants contributed to those weights. Internal comparisons instead use a fold-local ridge-35 reference fitted on the same subset as the challengers. The frozen external reference had more model-fitting participants than the challengers, so interpret it alongside the training-size-matched ridge-35 comparison.

The challengers are lower-penalty ridge, age-bin-weighted ridge, shallow nonlinear boosting, affine ridge, ridge with intervals stratified by predicted age, two frontal derivations, and two central derivations. The affine map predicts chronological age from the EEG estimate alone and uses a separate set for interval calibration. It can improve average calibration without curing systematic errors in true-age strata. The prediction-stratified intervals split at a training-prediction median and fall back to pooled calibration when either group has fewer than nine participants. Coverage assumes exchangeability within the applicable calibration population. These intervals carry no cross-site coverage guarantee.

Read MAE, signed error, predicted-on-observed slope, exact coverage intervals, interval width and paired bootstrap differences together. Report decade results where at least five participants are available. Paired bootstrap intervals condition on the fitted predictions and exclude model-refitting uncertainty. The frontal and central variants use two bipolar derivations each. The present paired ablation shares the full montage quality gate, so it cannot estimate yield or accuracy for a headset that lacks the other electrodes.

## Tests and outstanding experiments

Four tests passed on synthetic feature rows, covering duplicate participant rejection, incomplete cohort rejection, finite-sample conformal rank, and independence of Dortmund and Oslo output from changes to Athens inputs. The participant-level files were absent and the public metadata and S3 endpoints timed out from the execution environment. The cohort benchmark has no new measured model results.

To distinguish age-range effects from recording and population effects, compare sites over common age support with fixed age weights and show cohort counts before and after quality gating. Within the overlap, compare spectral slope, relative and absolute power, and missing alpha peak rates. Use a recording-matched reprocessing sensitivity analysis for reference, filters, duration and quality thresholds. Site and hardware are confounded in the three public cohorts, so a paired recording study is needed to quantify hardware effects.

For headset transfer, establish the exact electrodes and reference, run a gate using only the available derivations, and report usable-recording yield on all eligible sessions as well as accuracy on the paired subset. Validate the locked model and interval on a new headset cohort. Oslo and Athens are historical external benchmarks whose aggregate results were already reviewed. A fresh cohort is needed for confirmation after any choice based on their results. No candidate is selected from the available evidence.

Methods background: [Tveitstol et al., cross-dataset EEG generalisation](https://pubmed.ncbi.nlm.nih.gov/41329579/) and [de Lange et al., interpretation of brain-age metrics and bias correction](https://pmc.ncbi.nlm.nih.gov/articles/PMC9188975/).
