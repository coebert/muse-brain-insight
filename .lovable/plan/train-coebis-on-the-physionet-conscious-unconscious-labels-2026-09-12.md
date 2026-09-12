# Train COEBIS on the PhysioNet conscious/unconscious labels

The PhysioNet `eeg-power-anesthesia` files can already be uploaded on the Data exchange page: their published spectra are stored with their state labels kept verbatim. What is missing is the second half — nothing currently reads those labels back and uses them to improve the depth index.

## The honest limit, and how this plan handles it

Those recordings carry a state word ("awake", "unconscious"), not a monitor number. Turning "unconscious" into a made-up depth score of, say, 40 would teach the model a number nobody measured, and would quietly poison the pool that is currently graded against real bedside readings.

So the labels are used for what they genuinely are: a **separation target**. A good depth index must read high when the patient is responsive and low when they are not. That is gradeable, it is clinically meaningful, and it is exactly the thing BIS is criticised for getting wrong at the transitions.

## What gets built

**1. State-label training pool**
A loader that pulls the stored PhysioNet epochs that carry a usable state label, keeps only `awake` / `sedated` / `anaesthetised` / `burst_suppression`, collapses them into responsive vs unresponsive, and rebuilds the COEBIS input features from each stored spectrum. Kept under its own lineage, as the existing imports are; it never mixes into device-paired alignment.

**2. Separation grading**
For the current model, on this pool: how well it tells responsive from unresponsive (AUC), the average index in each state, the overlap between them, and the best cut-point with its sensitivity and specificity. Graded with whole-case holdout, so a case never appears in both fit and grade.

**3. A bounded state fit**
A correction fitted to maximise that separation, constrained so it can only reshape the index gently — it cannot invert the scale or push readings outside 0–100. It is graded against the same holdout and is only promoted when separation improves by a clear margin, through the existing model-version and promotion machinery, so the current model stays active if the candidate is no better.

**4. Where you see it**
A new section on the existing COEBIS admin page: how many labelled epochs and cases are in the pool, the separation score before and after, the state averages, the chosen cut-point, and a Run fit button that follows the same bounded-pass pattern as the other refits. Promotion is reported plainly, including when nothing was promoted.

## Technical notes

- New: `src/lib/eeg/state-labels.ts` (label collapsing, separation metrics, bounded fit), `state-labels.server.ts` (pool load from `external_spectral_epochs`, promotion), `state-labels.functions.ts` (authenticated server functions), `StateLabelPanel.tsx`.
- Reuses `coebis-covariates` feature construction and the `coebis_model_versions` lineage/promotion path; writes go through the privileged client as the other refits do.
- Pool reads are paged and capped, and the fit runs in bounded passes, to stay inside the server's per-request processing budget.
- Unit tests for label collapsing, separation metrics, holdout splitting, and the promotion gate.

## Not included

No new upload screen — the existing PhysioNet upload on Data exchange already accepts these files. No change to how bedside paired readings are graded.
