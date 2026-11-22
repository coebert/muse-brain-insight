# Timing and coordination in clinical EEG

A retrospective search tested whether timing between electrodes, slow-wave modulation of alpha activity and complexity added information to ordinary spectral power. Only aggregate outputs and fitted parameters are shared.

| Question | Result on held-out people | Interpretation |
|---|---|---|
| Can timing improve transfer of a propofol protocol classifier? | Adding the timing features changed AUROC from 0.985 to 0.975 from Cambridge to Oslo and from 0.913 to 0.888 in reverse. Each cohort had 20 people. | Five regional power measures replicated in the same direction after multiplicity correction. None of the 18 timing features passed that test. |
| Can EEG identify the type of dementia? | Among 87 eligible participants, the combined EEG model had AUROC 0.915 for Alzheimer’s disease versus controls, 0.785 for frontotemporal dementia versus controls and 0.391 for Alzheimer’s disease versus frontotemporal dementia. | Models trained on early segments and scored later segments in unseen people. In 199 participant-label shuffles, the respective adjusted p values were 0.014, 0.014 and 1.00. All data came from one centre. |
| Does the previous minute of EEG help detect neonatal seizures? | The model with history detected 84 of 483 events versus 81 using the current window. False starts fell from 1.01 to 0.89 per background hour. | Paired intervals include zero change. Sensitivity against two-reader agreement was approximately 13%, compared with 91–95% for the third reader. |
| Does the neonatal alarm threshold transfer? | With history, selected Boston paediatric clips yielded 5/12 events and 28.95 false starts per background hour. Selected Siena clips yielded 3/6 and 9.03 respectively. | Short, event-enriched external excerpts cannot estimate whole-cohort alarm burden. These thresholds performed poorly. |

The five reproducible power features were frontal and central power in 13–20 and 20–30 Hz and posterior power in 1–4 Hz. Frontal high frequencies are susceptible to muscle activity. The behavioural-response analysis also found no clear gain from timing over ordinary power. Neither the loss of movement nor the protocol label measures awareness.

The scripts next to this report include source extraction, waveform features, cohort analysis, label permutations, held-out seizure comparisons and deterministic replay checks. Aggregate JSON files are in temporal-results. All estimates describe retrospective research.
