# External-validation protocol — versioned draft

Status: **draft, version 2, 22 November 2026. Not approved. Not registered.**
This is a retrospective research protocol prepared for independent statistical
and clinical review and for prospective registration. It is pending independent
statistical and clinical approval and registration. **No independent statistical
or clinical approval has been given, and no registration has occurred.** Access
to new outcomes is prohibited until both are complete and the registered version
is locked with its own checksum. This draft does not authorise
a bedside alarm, a drug recommendation or any claim of awareness, sedation
adequacy or depth. **No clinical release follows from this protocol.**

**Prior result, unchanged.** In the six published awake-paralysed volunteers,
the frontal-alpha comparator labelled **one of six (1/6)** as sedated. That
result motivates this protocol; it is not an outcome of it and is not
re-estimated here.

## 1. Data: independent original voltages

- A different cohort from every training source. No participant, recording or
  published summary figure used to fit the comparators may appear again, and
  overlap between the participating groups must be resolved in writing first.
- Numerically sampled original voltages, not screenshots, power spectra or
  repeated playbacks of one volunteer.
- Per recording: montage, reference electrode, physical calibration, sampling
  rate, electrode locations, signal-quality flags, and synchronised medication,
  reversal and command/response timestamps.
- The ordinary replay is descriptor-only until the recording-side acquisition
  identity (case, acquisition time, reference) agrees with the independent
  context, or a provenance manifest bound to the recording's SHA-256 supplies
  that identity.

## 2. Blinded adjudication and command channel

- Response adjudication is blinded to the model output. Two adjudicators
  independently label each interval as responsive, unresponsive or
  indeterminate; disagreements are resolved by a third, also blinded.
- The command channel is recorded explicitly: verbal command with a confirmed
  motor response, or an isolated-forearm response where neuromuscular blockade
  is present. A non-movement observation is never treated as a response, and an
  unassessable motor pathway is never treated as unresponsive.
- Adjudicators record the eliciting channel and whether the motor pathway was
  assessable, so an absent movement cannot be mistaken for a lost response.

## 3. Endpoints and the sealed evaluator

Two systems must not be conflated:

- **Ordinary replay.** The shipped replay is descriptor-only. Under documented
  or suspected confirmed neuromuscular blockade it must abstain on 100% of
  intervals before reading model weights. Its abstention is a safety boundary,
  not a measurement: it cannot estimate sensitivity, specificity, discrimination
  or false sedation, and 100% abstention must never be reported as high
  specificity or as evidence of safety.
- **Sealed evaluator.** A separate offline analysis harness, access-controlled
  and run only by the independent analysis group, may load the frozen research
  model and compute a research score under confirmed block so that false
  sedation can be counted. It cannot issue alerts. Its outputs remain sealed
  until the registered analysis plan is locked. The sealed evaluator, not the
  ordinary replay, supplies the primary count.

Endpoints:

- **Primary safety endpoint:** the number of independent participants with a
  sedated label (research score at or above the frozen threshold) while
  confirmed awake paralysis and a confirmed command response are present, among
  participants the sealed evaluator can score. Report the exact binomial
  (Clopper–Pearson) 95% interval for this count. With zero observed events the
  upper bound is nonzero, `1 - 0.025^(1/n)`, and must be reported; it is never
  zero. Report the proportion among scored participants and, separately,
  coverage and abstention for all eligible participants.
- **Stable-block transition endpoint:** the first loss of a confirmed command
  response during a stable block. Stable block means a documented constant
  neuromuscular block with no bolus, no reversal and no change in the blocking
  infusion for at least five minutes before the transition.
- **Secondary repeated-time measures:** descriptor stability between eyes-closed
  and eyes-open wake, and the false-transition or false-episode rate. Repeated
  intervals are analysed with participant-cluster methods (a participant-level
  cluster bootstrap or cluster-robust variance), never as independent
  observations. Report the number of false episodes, their duration (median and
  total) and the total time affected in participant-hours and as a percentage of
  monitored time.

**An always-abstaining model has no discrimination estimate.** If the sealed
evaluator, or any candidate, abstains on every interval, AUROC, sensitivity,
specificity and paired ordering are not estimable and must be reported as not
estimable. A 100% abstention rate is not a performance result.

## 4. Analysis

- The participant is the unit of inference for the primary count. The primary
  interval is the exact binomial interval above. A participant bootstrap that
  resamples zero observed errors would report a misleading zero-width interval,
  so it is not used for the primary count.
- Repeated-time secondary measures use participant-cluster methods. Intervals
  within a participant are not treated as independent.
- Report the number of participants, the recorded duration, and the fraction of
  planned minutes that contributed complete analysable windows (coverage).
- Report every abstention with its reason. Abstentions are counted in the
  coverage denominator for all eligible participants and are never imputed,
  dropped or replaced by a default score.
- Report protocol deviations, including reversal before a sedated sample, and
  keep the reported label for that case rather than reclassifying it.

## 5. Decision parameters frozen before the test set opens

Before any access to new outcomes, the registered version must fix, with
independent statistical input:

1. The episode persistence rule: how many consecutive positive windows start and
   end an episode.
2. The score threshold and its direction.
3. The minimum usable coverage and the window-quality rule.
4. The prospective sample size and precision targets, including the precision of
   the exact binomial primary interval.
5. The sealed-evaluator software version and the frozen model artifact hash.

This draft deliberately sets no 10% or 25% error cut-off and no requirement of
zero false sedation. Those are not prespecified acceptance criteria. The
registered version, not this draft, contains the prespecified acceptance
criteria.

**Illustrative planning only.** The table below is arithmetic for the exact
binomial upper bound when zero events are observed. It is explicitly
illustrative, not a target, not a sample-size recommendation, and carries no
clinical-authorisation status.

| Scored participants | Zero events | Exact 95% upper bound |
|---:|---:|---:|
| 20 | 0/20 | 16.8% |
| 30 | 0/30 | 11.6% |
| 50 | 0/50 | 7.1% |
| 100 | 0/100 | 3.6% |

## 6. Deviations and versioning

Any deviation is recorded before analysis with its reason and is reported
alongside the primary result. This draft must not be edited to fit observed
results; a change requires a new version and a new checksum. The draft text is
hashed in `external-validation-protocol.sha256`. A changed digest means the
draft was edited. Version 1 is superseded. No version is approved or
registered, and no clinical release follows from any version.
