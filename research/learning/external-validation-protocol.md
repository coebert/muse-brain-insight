# Locked external-validation protocol

Status: **frozen**, version 1, 22 November 2026. This is a retrospective research
protocol. It is the prespecified analysis for the next independent cohort and
must not be edited to fit observed results; a change requires a new version and
a new lock file. **No clinical release follows from this protocol.** Nothing
here authorises a bedside alarm, a drug recommendation or a claim of awareness,
sedation adequacy or depth.

## 1. Data: independent original voltages

- A different cohort from every training source. No participant, recording or
  published summary figure used to fit the comparators may appear again, and
  overlap between the participating groups must be resolved in writing first.
- Numerically sampled original voltages, not screenshots, power spectra or
  repeated playbacks of one volunteer.
- Per recording: montage, reference electrode, physical calibration, sampling
  rate, electrode locations, signal-quality flags, and synchronised medication,
  reversal and command/response timestamps.
- The replay is descriptor-only until the recording-side acquisition identity
  (case, acquisition time, reference) agrees with the independent context, or a
  provenance manifest bound to the recording's SHA-256 supplies that identity.

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

## 3. Endpoints

- **Primary safety endpoint:** the proportion of participants in confirmed awake
  paralysis who receive a sedated label (research score at or above the fixed
  threshold) while a command response is confirmed.
- **Stable-block transition endpoint:** the first loss of a confirmed command
  response during a stable block. Stable block means a documented constant
  neuromuscular block with no bolus, no reversal and no change in the blocking
  infusion for at least five minutes before the transition.
- **Secondary:** descriptor stability between eyes-closed and eyes-open wake,
  and the false-transition rate per participant-hour.

## 4. Analysis

- The participant is the unit of inference. Every interval is a
  participant-level bootstrap (2000 resamples, fixed seed) reported as a
  two-sided 95% interval.
- Report the number of participants, the recorded duration, and the fraction of
  planned minutes that contributed complete analysable windows (coverage).
- Report every abstention with its reason. Abstentions are counted in the
  denominator and are never imputed, dropped or replaced by a default score.
- Report protocol deviations, including reversal before a sedated sample, and
  keep the reported label for that case rather than reclassifying it.

## 5. Prespecified acceptance criteria

All criteria must be met on the independent cohort before any further claim:

1. At least 30 participants and at least 5 minutes of stable block per
   participant.
2. Awake-paralysis false-sedation: point estimate at most 10%, with the upper
   95% participant-level bound at most 25%, and no participant with a confirmed
   command response labelled sedated.
3. Stable-block transition sensitivity at least 0.80 with a lower 95% bound of
   at least 0.60, and at most 0.5 false transitions per participant-hour.
4. Coverage at least 80% of planned analysable minutes in complete windows.
5. Abstentions at most 10% of recordings, each reported with a reason.
6. No training/validation participant overlap and no reuse of published
   summary figures.

Failing any criterion keeps the model research-only. Passing them supports a
prospective protocol, not clinical use.

## 6. Deviations

Any deviation is recorded before analysis with its reason and is reported
alongside the primary result. The locked text is hashed in
`external-validation-protocol.sha256`; a changed digest means the protocol was
edited and the change must be justified as a new version.
