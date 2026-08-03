# Consultant panel review — CortexTrace

Reviewed as if by a panel of consultant anaesthetists and intensivists: what works, what would stop us using it at the bedside, and what to build next.

## What already works well
- Sound signal chain: artefact rejection, EMG gating, OpenIBIS-style depth index validated against a reference (r = 0.974), qCON/qNOX-style composite, BIS-style heat-map DSA.
- Genuine explainability: every AI alert carries evidence features, time windows, clinician override rationale and a feedback loop.
- Data governance is ahead of most research tools: encryption at rest, export, deletion, passkey sign-in.

## Panel concerns (highest clinical impact first)

### 1. No case lifecycle, and data can be lost
Connecting the headband starts recording; pressing Stop just drops the Bluetooth link. There is no "start case / end case", no prompt to save on stop, and unsaved data is silently discarded. Patient context is only captured in the save dialog, at the end.

### 2. A dropout ends the case
A disconnect resets everything — elapsed clock, epoch buffer, DSA. In theatre and on ICU, headbands slip and Bluetooth drops. There is no auto-reconnect and no gap-preserving continuation.

### 3. Only one hour of live trend
The live buffer caps at 3600 epochs. A 14-hour sedation case silently loses its early history from the live view.

### 4. Alarms are not clinical alarms
The seizure banner cannot be acknowledged or silenced, does not escalate if ignored, and there is no audible cue at all. An unattended screen alarms to nobody.

### 5. Threshold changes are invisible
Eight live sliders re-tune seizure and suppression detection with no timestamped record of who changed what, and switching Anaesthesia/ICU mode mid-case silently re-tunes thresholds. That is a problem for later review of any alert.

### 6. Ergonomics for a bedside device
One long scrolling page (DSA, ribbon, markers, ten tiles, quality panel, AI panel, eight sliders, waveform, event log), pervasive 10-11px text, seven equal-weight nav links competing with the mode switch, no home/summary screen, and the research-use-only disclaimer buried at the very bottom.

### 7. No handover and no case report
No shift-change view, no visible case ID during monitoring, and no printable end-of-case summary to put in the notes.

## Implementation plan

### Phase 1 — Case safety (do first)
1. **Case lifecycle**: replace Connect/Stop with Start case → Monitoring → End case. Capture case code, age band, sex and setting *before* streaming; carry them in a `useCase` store and show the case code in the header. Ending a case opens the save dialog pre-filled; refuse to discard without an explicit "Discard case" confirmation. Add a `beforeunload` guard while unsaved.
2. **Resilient streaming**: auto-reconnect with backoff in `muse.ts` (5 attempts, exponential), a "Reconnecting…" header state, and gap-preserving epochs — the buffer keeps its timeline and marks the dropout as a coverage gap rather than resetting. Wire the existing `coverage.ts` gap model to the live path.
3. **Full-case live trend**: raise the live cap to the whole case using a two-tier buffer — full-resolution last 30 min plus a decimated (4:1, then 16:1) long tail for the DSA, so a multi-hour case stays visible without unbounded memory.

### Phase 2 — Alarms and audit
4. **Alarm manager** (`src/lib/eeg/alarms.ts` + `AlarmBanner.tsx`): active-alarm stack with severity, acknowledge, 2/5/10-minute silence, auto-re-arm, re-alarm on worsening, and a "silenced" indicator so a muted alarm is never invisible. Web Audio tones (distinct critical vs advisory pattern), off by default until the clinician enables sound, with a test-tone button.
5. **Settings audit trail**: every threshold change, mode switch and calibration swap writes a timestamped entry to the event log and the saved session, attributed to the signed-in clinician. Add a "Lock settings" toggle so thresholds cannot be dragged by accident during a case.

### Phase 3 — Ergonomics
6. **Restructure the monitor page** into three tabs under a permanently visible header (case ID, elapsed, depth, SR, SEF95, connection, alarm state): **Monitor** (DSA + tiles + markers), **Signal** (quality, waveform, artefact), **Review** (AI insight, evidence, event log). Settings move into a slide-over panel.
7. **Type scale and touch targets**: raise the floor to 12px, promote primary numerics, ensure ≥44px tap targets on marker chips and alarm controls; keep the fullscreen bedside view as the glance-from-across-the-room mode and add depth/SR trend and alarm state to it.
8. **Navigation**: header keeps Monitor, Cases and a Tools menu grouping Trends, Compare, Calibrate, Validate, Feedback, Performance. Rename `/calibrate` → "Depth calibration" and the performance panel → "Alert tuning" to remove the overlap. Move the passkey and privacy panels off `/sessions` into `/settings`.
9. **Disclaimer placement**: research-use-only shown at case start and as a persistent small header badge, not only in the footer.

### Phase 4 — Handover and reporting
10. **Case summary report**: a print-optimised end-of-case page — demographics, duration, time-in-range for depth, total suppression time and worst BSR, SEF95 trend, alert list with clinician decisions, coverage/quality statement, and a signature line. Print to PDF from the browser.
11. **Handover view**: a `/cases` landing screen listing recent and in-progress cases with last-seen depth/SR, outstanding alerts and unresolved alarms, so the incoming clinician sees "what needs my attention" first.

## Technical notes
- New: `src/lib/eeg/alarms.ts`, `src/lib/case/case-store.ts`, `src/components/monitor/AlarmBanner.tsx`, `src/components/monitor/CaseStartDialog.tsx`, `src/routes/_authenticated/cases.tsx`, `src/routes/_authenticated/report.$sessionId.tsx`, `src/routes/_authenticated/settings.tsx`.
- Changed: `useEegMonitor.ts` (lifecycle, reconnect, tiered buffer), `muse.ts` (backoff reconnect), `index.tsx` (tabs, header, alarm wiring — the 1380-line file splits into `MonitorTab`, `SignalTab`, `ReviewTab`).
- Database: add `settings_events` (jsonb audit rows on a session), extend `eeg_sessions` with `case_state`, `started_at`, `ended_at`, `clinician_id`; grants plus RLS scoped to the owning clinician, as with the existing tables.
- No change to the DSP, depth or composite maths — the validated numerics stay untouched.
