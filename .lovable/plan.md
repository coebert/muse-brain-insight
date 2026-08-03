# Engineering review and optimisation plan

A senior-developer audit of the codebase (25k lines, 60+ modules). The clinical behaviour is sound; the issues are structural: one very large dashboard file, duplicated monitor UI, redundant signal processing every second, and no tests on the clinically critical maths.

## What the review found

**1. Duplicated monitor UI.** The bilateral / combined / overlay DSA block exists twice, near-verbatim: in the dashboard (`index.tsx` ~832-895) and in `FullscreenMonitor.tsx` (245-332). Two "metric card" implementations (`MetricTile` and `BigNumber`) with overlapping tone logic. Any future change must be made twice, which is how the two views silently drift apart.

**2. Redundant DSP work.** Every hop (1 s) the app runs roughly 7 full FFTs on overlapping data: whole-signal analyser, left analyser, right analyser, per-channel signal quality (x4), plus a separate PSD inside `dsaSpectrum` for each hemisphere DSA lane — recomputing exactly what the hemisphere analyser just computed. On a phone this is wasted battery and adds latency.

**3. Render churn at streaming cadence.** Per hop, whole trend arrays are copied (`[...prev, epoch]`, up to 7200 entries) and every hemisphere event object is cloned. A second 200 ms interval allocates a fresh 1024-sample array 5x/second whether or not the waveform is visible. No component in `src/components/monitor` is memoised, and DSA `traces` are rebuilt inline each render, so the canvas redraws on unrelated state changes.

**4. Database rows are hand-typed and force-cast.** 19 `as unknown as` casts (trends, compare, report, calibration, alert actions) bypass the generated schema types, so a column rename would compile fine and fail at the bedside.

**5. Almost no tests.** Only passkey/WebAuthn are covered. FFT, PSD, filters, suppression detection, seizure scoring, depth index and Muse packet decoding — the clinically critical code — have zero coverage.

**6. No error boundary on the monitor.** An exception inside the analysis interval is swallowed by the browser: epochs quietly stop updating with no visible failure. Unacceptable for a bedside display.

## Plan

### Phase 1 — Shared monitor components (correctness/maintenance)
- Extract `HemiDsaPanel` (spectra, hemi metrics, events, view mode, window, markers) and use it in both dashboard and fullscreen.
- Extract one `MetricCard` with a `size` variant replacing `MetricTile` + `BigNumber`, and one shared tone helper.
- Extract the marker-position maths used by both views into a single helper.

### Phase 2 — Single-pass signal processing (performance)
- Compute one PSD per channel-group per hop and thread it through `analyze`, `signalQuality` and `dsaSpectrum` instead of recomputing. Target: FFTs per hop cut from ~7 to ~3.
- Derive the DSA dB spectrum from the analyser's existing PSD.
- Reuse scratch buffers in `computePsd` instead of allocating four arrays per call.

### Phase 3 — Render discipline
- Move epoch / hemi-spectra / SQI history into refs with a version counter (or `useSyncExternalStore`), publishing a new array reference only when the data the UI shows actually changes.
- Stop cloning every hemisphere event per hop — mutate the open episode only.
- Gate the 200 ms waveform loop on visibility and write into a persistent buffer.
- Wrap `DsaChart`, `MetricCard`, `HemiQualityBadge`, `WaveformStrip`, `SqiTrend` in `React.memo`; memoise `traces`/frames.

### Phase 4 — Type safety on stored data
- Derive row types from the generated `Database` types in one shared module; delete the per-route duplicates and the `as unknown as` casts.
- Centralise the vendor-prefixed `window`/`document` casts into typed helpers.

### Phase 5 — Tests on the clinical core
- Unit tests for `fft`/`computePsd` against known synthetic signals (single-tone power, Parseval), band powers, SEF95, spectral entropy.
- Tests for suppression-ratio and seizure scoring on synthetic burst-suppression and rhythmic-spike traces.
- Tests for Muse packet decoding and reconnect backoff.

### Phase 6 — Resilience and file size
- Error boundary around the monitor plus a guarded analysis loop that surfaces a visible "analysis stopped" state instead of failing silently.
- Split the 1657-line dashboard into route container + panels (status bar, DSA panel, metrics grid, dialogs). This lands last because Phases 1-3 remove most of its bulk.

## Technical notes
- No behaviour or clinical thresholds change in any phase; outputs must stay numerically identical (Phase 5 tests, written before Phase 2 lands where practical, protect this).
- Phases are independent and shippable one at a time; 1-3 give the biggest bedside benefit.
