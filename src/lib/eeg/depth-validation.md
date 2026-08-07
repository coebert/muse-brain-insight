# Depth index — calibration and validation against OpenIBIS

Reference: Connor CW. *Open Reimplementation of the BIS Algorithms for Depth of
Anesthesia.* Anesth Analg 2022;135:855–864 (`openibis.m`).

## Method

1. `scripts/depth-validation/openibis_ref.py` is a line-by-line NumPy port of
   the published `openibis.m` (128 Hz, 0.5 s stride, Blackman 4 s PSD,
   ±5 µV/2 s suppression rule, published mixer constants), used as ground truth.
2. `scripts/depth-validation/signals.py` synthesises six 7–9.5 min frontal
   sample sessions at 256 Hz covering awake, sedated, general anaesthesia,
   deep anaesthesia, burst suppression and isoelectric states:
   emergence ramp, induction ramp, steady GA, burst-suppression episode,
   ICU deep sedation, post-arrest (BS → isoelectric → deep).
3. `scripts/depth-validation/harness.ts` runs the shipped
   `DepthIndexEstimator` over the same sessions, optionally through the app's
   own 0.5–45 Hz + notch filter chain (`makeEegFilter`), at the app's real
   1 s epoch cadence.
4. `compare.py` / `strat.py` interpolate the reference onto the app's epoch
   grid and report Pearson r, bias, SD of differences, RMSE and Bland–Altman
   95 % limits of agreement.

Reproduce:

```bash
python3 scripts/depth-validation/gen.py          # sample sessions + reference
bun scripts/depth-validation/harness.ts /tmp/new.json filtered
python3 scripts/depth-validation/compare.py /tmp/new.json
```

## Calibration change

The previous index was a heuristic two-sigmoid blend of a beta ratio and a
broadband/high-band "SynchFastSlow" proxy. Against the reference it achieved
**r = 0.18, bias +28.2, RMSE 42.5, LoA −34 to +91** — i.e. no usable agreement.

It has been replaced with a streaming port of the actual OpenIBIS subparameters
and mixer: component 1 (30–47 Hz mean power − 11–20 Hz percentile-trimmed
mid-band power), component 2 (trimmed log ratio of the 40–47 Hz to 0.5–47 Hz
power concentrations), component 3 (0.5–4 Hz − mid-band power), the ±5 µV/2 s
BSR branch over a 63 s window, and the published `scurve`/`piecewise` mixer
constants — all unchanged from the paper.

## Agreement of the shipped implementation (n = 3075 epochs, 6 sessions)

Input passed through the app's own filter chain, as in live use:

| session | n | r | bias | SD | RMSE |
|---|---|---|---|---|---|
| emergence ramp | 563 | 0.987 | +2.1 | 5.9 | 6.3 |
| induction ramp | 563 | 0.991 | +1.0 | 5.0 | 5.1 |
| steady GA | 413 | 0.838 | −3.3 | 0.6 | 3.3 |
| burst-suppression episode | 533 | 0.063 | +2.6 | 7.7 | 8.1 |
| ICU deep sedation | 533 | 0.996 | +5.5 | 6.6 | 8.6 |
| post-arrest | 470 | 0.919 | +1.7 | 6.0 | 6.2 |
| **pooled** | **3075** | **0.974** | **+1.8** | **6.4** | **6.6** |

Bland–Altman 95 % limits of agreement: **−10.7 to +14.2** index units.
81.5 % of epochs within ±10 units, 99.4 % within ±15.

By state (reference mean → bias, 95 % LoA):

| state | ref mean | bias | 95 % LoA |
|---|---|---|---|
| awake | 91 | +2.6 | −2.7 to +7.8 |
| sedated | 47 | +10.1 | +2.2 to +18.0 |
| general anaesthesia | 20 | −3.1 | −7.4 to +1.2 |
| deep | 11 | −1.1 | −3.8 to +1.6 |
| burst suppression | 19 | +8.9 | +0.3 to +17.5 |
| isoelectric | 8 | −2.5 | −13.6 to +8.6 |

Without the app's filter chain (raw input) pooled agreement is r = 0.963,
bias +6.3, LoA −10.0 to +22.6 — the 45 Hz low-pass slightly *improves*
agreement by attenuating the same high-frequency content the reference's
40–47 Hz concentration term is sensitive to.

The low r in the burst-suppression session is expected: both signals sit in a
narrow near-floor range there, so correlation is uninformative while the error
band (SD 7.7) stays small.

## Known deviations (quantified above, not corrected for)

- 1 s epoch cadence instead of 0.5 s; 30 s spectral and 63 s suppression
  windows are unchanged in duration.
- The reference sawtooth detector is replaced by the depth-specific artefact
  gate described below (transient repair + EMG/spike/saturation rejection).
- Validation uses synthetic sample sessions, not recorded patient EEG, and the
  Muse frontal montage is not the BIS sensor montage.
- The index remains **uncalibrated against clinical endpoints**: it is a trend,
  and the ±10–15 unit error band above must be assumed at minimum.

## Artefact rejection and signal-quality gating (`src/lib/eeg/artifact.ts`)

Preprocessing tuned for the depth index specifically, because its
subparameters are log power ratios that lean on the 30–47 Hz band:

1. **Transient repair** — contiguous excursions beyond
   `max(60 µV, 5 × robust σ)` (σ from 1.4826 × MAD, so blinks cannot inflate
   their own threshold) are replaced by a linear ramp with a 20 ms shoulder.
   Blanking rather than clipping: a clipped blink still injects a broadband
   step into the 30–47 Hz band.
2. **Adaptive EMG rejection** — an epoch is rejected when the 30–45 Hz share
   exceeds 0.34 **or** absolute 30–45 Hz power exceeds 4 × the running median
   of the last 15 accepted epochs. The relative share alone misses EMG riding
   on high-amplitude slow activity (deep anaesthesia); the baseline is updated
   from accepted epochs only, so an artefact never raises the bar for the next.
3. **Periodic-spike (ECG/pacing) detection** — autocorrelation of the
   rectified derivative at 0.7–2.5 Hz, gated on a crest factor ≥ 6 and
   suspended when robust σ < 5 µV (suppressed records misfire the detector).
4. **Saturation / dropout / repair-load** — reject above 1 % rail samples,
   flat trace, or >8 % of samples repaired.

Rejected epochs never enter the 30 s spectral history; the index is *held* on
the last valid value (surfaced in the UI as "Held Ns — reason"), and depth
confidence is scaled down by the gated fraction of the window.

### Agreement under artefact load

The six sessions were re-run with injected artefacts (4 s frontalis-EMG bursts
every 40 s, 180 µV/300 ms blinks every 9 s, a 60 s run of 1.2 Hz ECG spikes —
13 % of samples contaminated), scored against the clean-signal reference:

| pipeline | r | bias | RMSE | 95 % LoA | epochs gated |
|---|---|---|---|---|---|
| no artefacts, gate active | 0.961 | +1.6 | 7.0 | −11.7 to +14.9 | 5.6 % |
| artefacts, gate bypassed | 0.619 | +10.5 | 26.1 | −36.2 to +57.2 | — |
| artefacts, gate active | 0.927 | +0.1 | 8.1 | −15.7 to +15.9 | 32.9 % |

Gating removes essentially all of the artefact-induced positive bias
(+10.5 → +0.1 units) and cuts RMSE by 69 %. The cost on clean signal is small
(r 0.974 → 0.961, RMSE 6.6 → 7.0), driven by genuine high-frequency activity
during emergence occasionally tripping the EMG surge test.

Reproduce with `scripts/depth-validation/contaminate.py` (writes `art_*.csv`)
then `bun scripts/depth-validation/harness_art.ts out.json gated|raw [sess|art]`.

## Alignment against a commercial BIS monitor (`src/lib/eeg/bis-drift.ts`)

Paired points (transcribed BIS value + the app's contemporaneous index) are
filed with each saved case and pooled across all cases. The pooled watch
reports the mean offset (app − BIS) with a 95 % confidence interval, per-depth-
band offsets and the offset over the most recent 60 readings.

Once there are ≥ 30 paired readings across ≥ 3 cases, the offset is
statistically clear (CI excludes zero) and ≥ 3 index points, the app fits
`BIS ≈ gain × index + offset` by least squares — shrunk toward the identity by
`n/(n+40)` — and activates it automatically, provided gain stays within
0.6–1.6, |offset| ≤ 30 and mean absolute error improves by ≥ 1 index point.

The correction is a monotone affine map of the *finished* index only. The
published openibis subparameters, mixer constants and suppression branch are
untouched, so the calibration and validation figures above still describe the
underlying model. The correction can be removed at any time from the model
performance screen.
