# Bedside usability review — consultant panel findings and plan

## What the panel found

The clinical content is strong. The problem is *reach*: during a live case the things a
consultant actually touches — markers, TCI targets, alarm limits, depth target window —
are spread across three tabs, four popovers and three dialogs, and the full-screen
"Monitor view" that would normally stay up on the anaesthetic screen is display-only.

Specific criticisms:

1. **The monitor view is a dead end.** No markers, no TCI, no alarm acknowledgement,
   no limits. Anything actionable means leaving the display you want to keep up.
2. **Markers are below the fold.** Preset chips sit under the DSA card, so during
   induction you scroll to record induction.
3. **Alarm limits are scattered.** SQI threshold is a popover on the DSA header,
   the depth target window is a popover at the very bottom of the Monitor tab, and
   the seizure/suppression/trend limits are on a different tab. There is no single
   "limits" page a consultant can check before knife-to-skin.
4. **TCI editing is a scroll away** and there is no persistent read-out of what is
   running, so the current regimen is invisible while looking at the DSA.
5. **No event log on the Monitor tab** — you mark events on one tab and can only
   review them on another.
6. **Inconsistent controls**: DSA view is a 3-way segmented control on the dashboard
   but a cycling button in full screen; zoom/pan has no reset button or indicator.
7. **Case admin is noisy**: three separate routes to the same filing dialog.

## The plan

### Phase 1 — One-thumb actions during a case (highest value)

- **Persistent action bar.** A slim bar pinned to the bottom of the screen whenever a
  case is running, present on the dashboard *and* in full-screen monitor view:
  `Mark` · `TCI` · `Limits` · `Alarms` · `Log`. Each opens a sheet over the current
  view; the DSA is never lost.
- **Mark sheet.** Large 44px+ chips for the presets, grouped: Airway/Access,
  Drugs, Surgical, Neuro observations. One tap marks and closes. Free text at the
  bottom. Long-press (or a secondary control) to back-date a marker by 30/60/120 s
  for the "I noticed that a minute ago" case.
- **Quick-mark row in full screen.** The four most-used markers for the current mode
  rendered directly, no sheet needed.
- **Undo everywhere.** A 10-second undo toast for every marker, TCI change and alarm ack.

### Phase 2 — One place for limits

- **Unified `LimitsSheet`** collecting every threshold that alarms: depth target
  window, SQI floor, seizure score, suppression amplitude and SR window, depth
  drop/rise trends, BSR burden. Grouped as *Depth*, *Suppression*, *Seizure*,
  *Signal*, each row showing current value, unit and current live reading beside it.
- **Mode-aware defaults** with a visible "Anaesthesia defaults / ICU defaults" reset,
  and an "off-default" badge so a colleague taking over sees limits were changed.
- Old popovers become deep-links into the corresponding section of this sheet, so
  nothing moves out of reach — it stops being *three different* patterns.

### Phase 3 — Keep the case state visible

- **TCI status strip**: one line under the header showing every running pump and its
  Ce, tappable to open the TCI sheet. Visible in full screen too.
- **Inline Ce stepper** in the TCI sheet stays as is, plus "last change" time so it is
  obvious how recently a target moved relative to a DSA change.
- **Event log rail**: last five entries always visible at the foot of the Monitor tab,
  with "open full log" to the sheet.
- **Alarm banner in full screen**, with per-side acknowledge, matching the dashboard.

### Phase 4 — Ergonomics and consistency

- Same 3-way segmented DSA control in both views; zoom/pan gains a visible
  "Live / zoomed" indicator with a reset-to-live button.
- **Landscape phone layout** for full screen: DSA left, numerics right, action bar
  bottom, nothing below the fold.
- **Case admin simplified** to `End case` (which offers "file" or "discard") plus a
  quieter `File now` in an overflow menu.
- **Glove/theatre-light pass**: minimum 44px targets on every live-case control,
  higher contrast on numerics, and a dim mode for darkened theatres.

### Phase 5 — Handover and start-up speed

- **Start case in two taps**: remember the last context, location and detection preset
  per device; case code auto-suggests the next sequential anonymised code.
- **Pre-case checklist card**: electrode contact, limits confirmed, mode confirmed —
  three ticks, dismissible, recorded into the timeline.
- **Handover summary**: a one-screen "what has happened so far" (time in window, SR
  burden, alerts, TCI history) reachable from the action bar.

## Technical notes

- New `src/components/monitor/CaseActionBar.tsx` plus sheets
  (`MarkSheet`, `TciSheet`, `LimitsSheet`, `LogSheet`) built on the existing
  `components/ui/sheet` primitive; shared by `routes/_authenticated/index.tsx` and
  `FullscreenMonitor.tsx` through a single `useCaseControls` hook so both views
  render identical behaviour from one source of truth.
- Threshold state consolidates into one `useAlarmLimits` hook wrapping the existing
  `monitor.settings`, depth-window prefs and SQI prefs, persisted per device as today.
- `TciPanel` splits: `TciStatusStrip` (read-only, always visible) and the existing
  editor moved into `TciSheet`.
- Marker back-dating uses the existing `monitor.elapsed` minus an offset; no changes
  to the analysis pipeline or database schema are needed for any phase.
- Existing tests stay green; new tests cover limit persistence, back-dated markers and
  action-bar availability in both views.
