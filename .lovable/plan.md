# Making CortexTrace depth measurement match — then beat — commercial BIS

## Where the app stands today

The measurement chain is sound but the learning layer is thin:

- **OpenIBIS depth index** is computed per epoch from three spectral subparameters plus a burst-suppression branch, with artifact gating and hemisphere preference. This is the physiological core and it works.
- **COEBIS** is currently a *single-predictor* correction: it fits `BIS ≈ gain × depthIndex + offset`, shrunk toward identity, plus a 7-knot residual curve. Nothing else enters the fit.
- **Age, sex and clinical features are never used by any model.** They are captured and stored, and passed to the AI for narrative interpretation only.
- **Paired BIS readings are scalar snapshots.** A paired point stores `app_index`, `bis`, `bis_sef`, `bis_sr` and a case-clock time, but has no link to the epoch it came from — so the rich per-epoch feature vector (bands, entropy, power ratios, subparameters, BSR, signal quality) is thrown away at exactly the moment the ground truth arrives.
- **TCI effect-site concentrations are never saved.** Ce history lives in memory for the duration of a case and is lost. This is the single biggest missed dataset: drug state is what BIS itself cannot see.
- **Free-text clinical detail is encrypted at rest** (diagnosis, notes, case summary, structured case facts). Good for privacy, but it means covariate modelling has to happen server-side after decryption, not in SQL.

The result: COEBIS can only ever learn *one* global correction curve. It cannot learn that an 84-year-old on ketamine reads differently from a 30-year-old on propofol alone — which is precisely the advantage you are trying to build.

## The goal, restated as engineering targets

To claim parity-or-better with commercial BIS you need three measurable things:

1. **Agreement** — bias, MAE and Lin's CCC against paired BIS, reported with confidence intervals and broken down by depth band.
2. **Discrimination** — the index must separate clinically labelled states (awake / sedated / anaesthesia / burst suppression) at least as well as BIS does on the same cases.
3. **Population-conditioned accuracy** — error must not vary systematically with age, sex, drug regimen or pathology. Commercial BIS *does* drift with these; if yours doesn't, that is the winning claim.

Everything below serves one of those three.

## Phase 1 — Capture the data the model needs (foundation)

Nothing else works until each ground-truth reading carries its full context.

**1.1 Epoch-anchored paired points.** Extend `bis_paired_points` with a feature snapshot taken at the instant the reading is entered: band powers, entropy pair, power ratios, the three OpenIBIS subparameters, BSR, SEF, artifact/EMG level, SQI per side, and which hemisphere was preferred. Backfill historic points by nearest-neighbour join from `eeg_epochs.t_offset_seconds`.

**1.2 Persist TCI.** New `tci_infusions` and `tci_ce_points` tables, written continuously during a case and on save. Each paired point then resolves propofol Ce, opioid Ce and any ketamine co-administration at that timestamp. Interpolate between recorded points.

**1.3 Structured, queryable covariates.** Keep the free text encrypted, but promote a small set of modelling covariates to plaintext columns on `eeg_sessions`: age band (already there), sex, ASA-style frailty flag, and a fixed vocabulary of clinical features (already there). Add an explicit `regimen` field (propofol TIVA / volatile / propofol+ketamine / etc.) chosen at case start — cheap to enter, high modelling value.

**1.4 Denormalised training view.** One server-side function that assembles the full training matrix: one row per paired point with outcome (`bis`), predictors (feature vector + Ce values), and covariates (age, sex, regimen, clinical features, context, quality). Everything downstream reads this.

## Phase 2 — A covariate-aware COEBIS (COEBIS-2)

Replace the single global gain/offset with a hierarchical model, staged so it degrades gracefully at low data volume:

- **Tier A (now, ~10 points):** current global affine + knots. Unchanged fallback.
- **Tier B (~60 points, 5+ cases):** affine correction with **covariate-modulated gain and offset** — additive terms for age band, regimen and burst-suppression presence, each heavily shrunk toward zero so a term only activates once it has earned its keep.
- **Tier C (~200 points, 15+ cases):** **mixed-effects** fit with a per-case random intercept. Paired readings within one case are correlated; treating them as independent (as now) overstates confidence and lets one long case dominate. This alone will improve honest error estimates.
- **Tier D (~500 points):** replace the affine core with a small gradient-boosted or regularised regression over the full feature vector + covariates, with the affine model retained as a guardrail — if the learned model deviates from the affine prediction by more than a set margin, clamp and flag.

Guardrails carry forward at every tier: gain limits, offset caps, minimum MAE improvement, and refusal to activate a model that fails held-out validation.

## Phase 3 — Honest validation

The current sufficiency checklist measures *how much data* you have. It needs to measure *how good the model is on data it has not seen*.

- **Leave-one-case-out cross-validation** as the primary metric. Report out-of-fold MAE, bias and CCC — never in-sample fit — and refuse promotion from provisional to confirmed on in-sample numbers.
- **Stratified error report:** MAE and bias by age band, sex, regimen, depth band, and signal-quality tier. This is the report that demonstrates the age/sex advantage, and it doubles as a bias detector.
- **Head-to-head panel:** OpenIBIS raw vs COEBIS-1 vs COEBIS-2 vs commercial BIS on the same held-out cases, one table, one chart.
- **Label-based discrimination:** using the existing depth-state labels, compute how cleanly each index separates states (prediction probability / AUC between adjacent states). This is where "better than BIS" can actually be demonstrated, because BIS is known to be weak at the awake–sedated boundary and in the elderly.
- **Sample-size guidance:** show how many more paired readings, and in which subgroups, are needed to move each tier forward. Turn data collection into a directed task rather than a hope.

## Phase 4 — Make collection effortless

The model is data-limited, so the entry path must be near-frictionless.

- **One-tap paired capture** on the monitor: a prominent control that snapshots the current app state and asks only for the BIS number (and optionally SEF/SR), pre-filling everything else.
- **Capture prompts** at high-information moments — induction, first burst-suppression, emergence, and any large depth swing — because paired points at the extremes are worth far more to the fit than yet another reading at steady state.
- **Subgroup gap dashboard:** "you have 4 readings in the 75–89 age band and 61 in 40–59" — so you know which cases to prioritise.
- **Quality-weighted fitting:** readings taken during poor signal quality contribute less weight rather than being included or excluded outright.

## Phase 5 — Clinical framing of the advantage

- **Age-adjusted target window.** The 40–60 window is a one-size-fits-all convention. With age in the model, show a personalised window and flag when a patient is deeper than their age-adjusted expectation despite a "normal" number — the elderly over-sedation problem BIS misses.
- **Explain the adjustment.** Whenever COEBIS-2 shifts the number, state why in one line ("+3 for age band 75–89 on propofol+ketamine"). Trust requires visibility.
- **Per-case model report** in the archive: which model version produced each number, its out-of-fold error at the time, and whether that case later contributed to training.

## Technical notes

- Fitting stays server-side in server functions so encrypted fields can be decrypted in-process; nothing sensitive reaches the client or the database in plaintext.
- Mixed-effects and boosted fits run in pure TypeScript (no native deps) — an IRLS/EM loop for random intercepts and a small depth-limited tree ensemble are both tractable at the data volumes involved and satisfy the Worker runtime constraints.
- Model artefacts extend the existing `depth_bis_alignments` versioning: new columns for model family, covariate coefficients, and out-of-fold metrics, so the version picker, drift watch and residuals panels keep working unchanged.
- Every new table gets grants plus owner-scoped RLS, matching existing tables.
- Backfill of historic paired points is a one-off server function, reversible and idempotent.

## Suggested order

Phase 1 first and in full — it is the bottleneck, and every day of data collected without it is data you cannot model on later. Then Phase 3's cross-validation harness (so you can *see* whether changes help), then Phase 2 tiers B and C, then Phase 4, then Phase 5.
