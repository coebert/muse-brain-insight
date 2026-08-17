# Improving measurement accuracy and clinical validity

A full review of the signal chain (DSP → OpenIBIS depth → adjuncts) and the statistics chain (COEBIS fitting → validation → reporting) found the core physiology is sound, but a set of specific weaknesses either bias the numbers or make them look more certain than they are. The plan below is ordered so the things that silently corrupt data are fixed first.

## What the review found

**Signal chain**
- Two different spectral engines run side by side: a Hann/FFT power spectrum for entropy, SEF95, DSA and band powers, and a separate Blackman direct-DFT for the depth index. They use different windows, different normalisation and different units, yet both feed the entropy/Masimo-style adjunct. Any disagreement between them is unmodelled.
- Two different burst-suppression definitions coexist: ±5 µV over 2 s (depth index, matching the reference) and 8 µV peak-to-peak over 0.5 s with a 60 s window (clinical suppression ratio). Both are displayed as "suppression" without reconciliation.
- Only the depth path removes linear baseline drift. Everything else subtracts the mean only, so dry-electrode drift inflates delta power and the ratios built on it.
- The anti-EMG low-pass is a single 12 dB/oct stage at 45 Hz, leaving real EMG energy inside the 30–47 Hz band the depth index depends on; mains frequency is user-selected with no automatic check.
- Suppression seconds can still be counted on near-flat epochs graded "fair" rather than "poor", so a partly detached electrode can read as suppression.
- The seizure detector is the least validated component: fixed uncalibrated thresholds, no evolution criteria, and EMG contamination reduces the reported confidence but not the score itself, so rhythmic artefact can still cross the alarm threshold.
- Depth confidence cut-offs (0.35 / 0.6) are hand-picked and never checked against reality, even though the app already contains proper calibration machinery used only for AI-alert grading.

**Statistics chain**
- The largest single bias: commercial BIS is smoothed and lags the EEG by roughly 15–30 s. Paired readings are entered as if simultaneous, so every reading taken while depth was changing carries a lag error that the fit absorbs as a real offset. Nothing detects this.
- Confidence intervals on the pooled bias use sd/√n, treating many readings from one case as independent. Intervals are therefore too narrow, and they feed the "the offset is real, correct for it" gate.
- Tier B (patient-adjusted) is deployed without any per-case declustering — the exact failure mode the code's own comments warn about.
- Around twenty subgroup and covariate tests run with no multiplicity control, so spurious "weak spots" and covariate corrections are expected by chance.
- Covariate terms are fitted independently and summed; age, frailty and regimen are collinear in practice, so effects get double-counted. No interactions, no collinearity diagnostics.
- Effect-site concentrations are captured but never used in the fit — the richest available predictor of drug state is dormant.
- The correction curve is seven independent knots with no smoothness or monotonicity constraint, so a non-monotone correction is possible.
- Two different "% within band" figures exist (one Gaussian-estimated, one empirical) and can disagree.
- Baselines anchor on the first 3 (case) or 30 (session) values with no quality gate — exactly the noisiest part of a case.
- Tier promotion needs a 0.2-point MAE gain with no test of whether that gain is distinguishable from noise.
- Prediction probability (Pk) and ROC/AUC state discrimination — the standard depth-monitor validation metrics — are absent; Bland-Altman limits ignore repeated measures.

## Plan

### Phase 1 — Stop corrupting the data (highest priority)
1. **Lag correction for paired readings.** Record the monitor's smoothing lag per device, shift the app index back by an estimated lag before pairing, and estimate the lag from the data by minimising MAE (not maximising r) across candidate shifts. Flag readings taken during rapid depth change and down-weight them.
2. **Stability gating at capture.** Compute dIndex/dt at the moment of capture; label each paired point stable / transitional, and record it. Sufficiency checks then require coverage of stable points across depth bands, not just band spread.
3. **Cluster-robust intervals everywhere.** Replace sd/√n with cluster bootstrap or a design-effect correction for every quoted bias/MAE interval, including the sufficiency "offset is real" gate.
4. **Decluster Tier B.** Apply the two-pass per-case intercept correction used in Tier C when fitting Tier A/B coefficients, so one long case cannot masquerade as an age effect.

### Phase 2 — One measurement, one definition
5. **Unify the spectral engine.** Single Blackman-windowed, FFT-based, µV²/Hz-calibrated estimator serving depth, entropy, adjuncts, SEF95 and DSA. Re-run the depth validation harness to confirm the OpenIBIS index is unchanged.
6. **Reconcile the two suppression metrics.** Make the reference ±5 µV / 2 s / 63 s definition the single published BSR; retain the second only as an internal sensitivity check, clearly labelled.
7. **Linear detrend before every PSD**, not just the depth path.
8. **Steeper anti-EMG filter** (cascaded biquads, ≥4th order) plus automatic mains-frequency detection from the spectrum with a warning when the selected value disagrees.
9. **Gate suppression counting on flatness**, not only on composite grade, so lead-off cannot read as suppression.
10. **Distinct live iso-electric state** rather than retrospective classification at episode close.

### Phase 3 — A statistically honest model
11. **Penalised monotone correction curve.** Replace independent knots with a joint P-spline under a monotonicity constraint and one cross-validated smoothing strength.
12. **Joint covariate regression.** Fit all covariate levels in one ridge model instead of sequential independent shrinkage; add collinearity diagnostics and test age×regimen interaction before allowing it.
13. **Effect-site concentration as a predictor.** Bring propofol/opioid/ketamine Ce into the fit as a smooth continuous term, with regimen retained as a fallback when Ce is absent.
14. **Multiplicity control.** Benjamini-Hochberg FDR across subgroup and covariate tests; report adjusted findings only.
15. **Statistical tier promotion.** Require the held-out MAE gain to exceed its own uncertainty (paired test across case folds) before adopting a richer tier.
16. **Reconcile the two in-fit percentages** — publish the empirical one, drop the Gaussian estimate.
17. **Quality-gated baselines**, requiring the baseline window to meet a reliability bar rather than simply being first.

### Phase 4 — Validate the way the field validates
18. **Prediction probability (Pk)** against the ordinal depth-state labels, for OpenIBIS raw, COEBIS and commercial BIS side by side.
19. **ROC/AUC for the clinically important boundaries** — awake vs sedated, adequate vs burst suppression.
20. **Repeated-measures Bland-Altman**, decomposing within- and between-case variance before computing limits of agreement.
21. **Patient-level prospective split** so a case straddling a model lock cannot appear in both training and unseen sets.
22. **Seizure detector validation pack**, mirroring the existing depth validation: labelled ictal and artefact vignettes, sensitivity/specificity/false-alarm rate per hour, published as a markdown record.
23. **Calibrate the confidence thresholds** using the existing reliability machinery — check how often "reliable" epochs actually agreed with the reference and move the 0.35/0.6 cut-offs to where the data puts them.

### Phase 5 — Presentation of certainty
24. **Fold EMG contamination into the seizure score itself**, not only its confidence.
25. **Retire the unfiltered depth aggregates** in the feature digest so downstream reports and AI context cannot silently ignore reliability gating.
26. **Replace the single 0–100 confidence score** with its components plus an explicit statement of what is still missing, since a blended hand-weighted score invites over-trust.
27. **Show the lag assumption and stability label** on every paired reading and in the model report, so a reader can see what the fit was built on.

## Technical notes
- Phase 1 and 2 change numbers that have already been recorded. Each gets a versioned computation flag on stored epochs and paired points so historic data stays interpretable and can be re-scored rather than silently reinterpreted.
- The depth validation harness (`scripts/depth-validation`) is the regression gate for Phases 2 and 3: no spectral or mixer change lands without re-running it and recording the new agreement table.
- All fitting stays in server functions; the new spline, ridge and Pk/ROC routines are pure TypeScript with no native dependencies.
- Model artefacts extend the existing alignment versioning, so the version picker, drift watch and residual panels keep working.

## Suggested order
Phase 1 first and in full — every case recorded without lag and stability metadata is a case that cannot be corrected later. Then Phase 4's Pk/ROC harness, so the effect of every later change is measurable, then Phase 2, Phase 3, and Phase 5.
