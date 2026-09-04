import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";
import { Bluetooth, ChevronDown, Moon, Save, Square, Sun, X } from "lucide-react";

import { AlarmBanner } from "@/components/monitor/AlarmBanner";
import { CvaWatchPanel } from "@/components/monitor/CvaWatchPanel";
import { LiveWaveform } from "@/components/monitor/LiveWaveform";
import { TrendLine } from "@/components/monitor/TrendLine";
import { useCaseSession } from "@/components/monitor/CaseSessionProvider";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DEPTH_STATE_LABEL, depthTone } from "@/lib/eeg/depth";
import { formatClock } from "@/lib/eeg/format";
import type { WaveformStore } from "@/lib/eeg/waveform-store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/bedside")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Bedside monitor — CortexTrace" },
      {
        name: "description",
        content:
          "Distraction-free bedside screen: live depth index, suppression and EEG amplitude from a Muse or Regul8 headband.",
      },
      { property: "og:title", content: "Bedside monitor — CortexTrace" },
      {
        property: "og:description",
        content: "Live depth of anaesthesia, suppression and EEG amplitude at the bedside.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BedsidePage,
});

/** One instrument reading: caption, big number, unit, one line of context. */
function Instrument({
  label,
  value,
  unit,
  note,
  tone = "default",
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  tone?: "default" | "signal" | "caution" | "critical";
}) {
  return (
    <div className="instrument">
      <p className="instrument-label">{label}</p>
      <p
        className={cn(
          "metric-value mt-0.5 text-3xl tabular-nums",
          tone === "critical"
            ? "text-critical"
            : tone === "caution"
              ? "text-caution"
              : tone === "signal"
                ? "text-signal"
                : "text-foreground",
        )}
      >
        {value}
        {unit ? <span className="ml-1 text-base text-muted-foreground">{unit}</span> : null}
      </p>
      {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** Live amplitude of the trace, in the units the connected band actually gives. */
function useAmplitude(store: WaveformStore) {
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  return { rms: data.length ? Math.sqrt(sum / data.length) : null, peak };
}

function BedsidePage() {
  const session = useCaseSession();
  const {
    monitor,
    streaming,
    reconnecting,
    caseState,
    testing,
    meta,
    saving,
    saved,
    hasUnfiledData,
    derived,
    latest,
    summary,
    alarms,
    depthWindow,
    startCase,
    endCase,
    handleSave,
    dim,
    setDim,
  } = session;
  const [detailOpen, setDetailOpen] = useState(false);

  const profile = monitor.deviceProfile;
  const calibrated = profile.calibratedAmplitude !== false;
  const unit = calibrated ? "µV" : "a.u.";
  const { rms, peak } = useAmplitude(monitor.waveformStore);

  const index = derived.live.depthIndex;
  const state = latest?.depth.state ?? null;
  const tone = state ? depthTone(state) : "default";
  const sr = derived.live.suppressionRatio;
  const trend = monitor.epochs.map((e) => e.depth?.index ?? null);
  const band: [number, number] = [depthWindow.prefs.low, depthWindow.prefs.high];
  const inBand = index != null && index >= band[0] && index <= band[1];

  return (
    <div className={cn("min-h-dvh bg-background transition-[filter]", dim && "brightness-[0.55]")}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <span
          className={cn(
            "size-2 rounded-full",
            streaming ? "bg-signal" : reconnecting ? "bg-caution" : "bg-muted-foreground/50",
          )}
          aria-hidden
        />
        <span className="metric-value text-sm">
          {streaming ? profile.label : reconnecting ? "Reconnecting…" : "No headband"}
        </span>
        <span className="metric-value text-sm text-muted-foreground">
          {formatClock(monitor.elapsed)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => setDim(!dim)}
            aria-label={dim ? "Brighten screen" : "Dim screen"}
          >
            {dim ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
            <Link to="/" aria-label="Leave the bedside screen">
              <X className="size-4" />
            </Link>
          </Button>
        </div>
      </header>

      {/* One alarm strip for the whole screen; nothing else raises its own. */}
      {alarms.alarms.length ? (
        <div className="px-3 pt-2 sm:px-4">
          <AlarmBanner
            alarms={alarms.alarms}
            audioEnabled={alarms.audioEnabled}
            muted={alarms.muted}
            muteRemaining={alarms.muteRemaining}
            onAcknowledge={alarms.acknowledge}
            onAcknowledgeAll={alarms.acknowledgeAll}
            onAcknowledgeSide={alarms.acknowledgeSide}
            onPauseAudio={alarms.pauseAudio}
            onResumeAudio={alarms.resumeAudio}
            onToggleAudio={() => alarms.setAudioEnabled(!alarms.audioEnabled)}
          />
        </div>
      ) : null}

      <main className="mx-auto max-w-4xl px-3 py-4 sm:px-4">
        {/* The number, as the one dominant object on the screen. */}
        <section className="signal-halo relative rounded-xl border border-border bg-card/40 px-4 py-6 text-center">
          <p className="instrument-label">
            Depth index · target {band[0]}–{band[1]}
          </p>
          <p
            className={cn(
              "metric-value mt-1 text-[92px] leading-[0.85] tabular-nums sm:text-[136px]",
              tone === "critical"
                ? "text-critical"
                : tone === "caution"
                  ? "text-caution"
                  : inBand
                    ? "text-signal"
                    : "text-foreground",
            )}
          >
            {index == null ? "—" : Math.round(index)}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {state ? DEPTH_STATE_LABEL[state] : "Waiting for signal"}
            {index != null && !inBand ? " · outside target" : ""}
          </p>
          <div className="mt-4">
            <TrendLine
              values={trend}
              min={0}
              max={100}
              color="var(--signal)"
              band={band}
              height={78}
              unit=""
              precision={0}
            />
          </div>
        </section>

        {/* Instrument tiles: the three readings that qualify the number. */}
        <section className="mt-3 grid gap-3 sm:grid-cols-3">
          <Instrument
            label="Suppression"
            value={sr == null ? "—" : sr.toFixed(0)}
            unit="%"
            note={`${Math.round(summary.suppressionSeconds)} s suppressed this case`}
            tone={sr != null && sr >= 40 ? "critical" : sr != null && sr >= 10 ? "caution" : "default"}
          />
          <Instrument
            label="Amplitude scale"
            value={rms == null ? "—" : rms.toFixed(1)}
            unit={`${unit} rms`}
            note={`peak ${peak ? peak.toFixed(0) : "—"} ${unit} · ${
              calibrated ? "real microvolts" : "arbitrary units, band not calibrated"
            }`}
          />
          <Instrument
            label="Signal quality"
            value={derived.live.sqi == null ? "—" : String(derived.live.sqi)}
            unit="%"
            note={profile.channels
              .map((c) => `${c} ${monitor.contactOk[c] ? "ok" : "poor"}`)
              .join(" · ")}
            tone={
              derived.live.sqi != null && derived.live.sqi < 50
                ? "caution"
                : derived.live.sqi != null
                  ? "signal"
                  : "default"
            }
          />
        </section>

        {/* Sudden one-sided loss of EEG — visible at the trolley, not folded away. */}
        <div className="mt-3">
          <CvaWatchPanel
            hemiSpectra={monitor.hemiSpectra}
            sqiHistory={monitor.sqiHistory}
            bilateral={
              profile.channels.some((c) => c === "TP9" || c === "AF7") &&
              profile.channels.some((c) => c === "TP10" || c === "AF8")
            }
          />
        </div>

        {/* Everything else folds away, so the number owns the screen. */}
        <Collapsible open={detailOpen} onOpenChange={setDetailOpen} className="mt-3">
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="min-h-11 w-full justify-between">
              <span>{detailOpen ? "Hide detail" : "Show detail"}</span>
              <ChevronDown
                className={cn("size-4 transition-transform", detailOpen && "rotate-180")}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Instrument
                label="Spectral edge (SEF95)"
                value={derived.live.sef95 == null ? "—" : derived.live.sef95.toFixed(1)}
                unit="Hz"
                note="Frequency below which 95% of the power sits"
              />
              <Instrument
                label="Sensors"
                value={`${profile.channels.filter((c) => monitor.contactOk[c]).length}/${profile.channels.length}`}
                note={`${profile.label} · ${profile.sampleRate} Hz`}
                tone="signal"
              />
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card/60">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <h2 className="text-sm font-semibold">Live EEG · last 4 s</h2>
                <span className="metric-value text-xs text-muted-foreground">
                  0.5–45 Hz · {calibrated ? "±80 µV" : "auto-gained"}
                </span>
              </div>
              <div className="h-[140px] px-2">
                <LiveWaveform
                  store={monitor.waveformStore}
                  suppressionThresholdUv={monitor.settings.suppressionThresholdUv}
                  suppressed={latest?.isSuppressed ?? false}
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              A case started here records the same trend, suppression and events as the full monitor
              and is filed to the same timeline, so the depth dashboard can compare it. On a Muse the
              amplitude is in real microvolts; a Regul8 streams arbitrary units, so its scale is
              relative, and on either band the depth index is an extrapolation of a model fitted on
              theatre recordings.
            </p>
          </CollapsibleContent>
        </Collapsible>

        <section className="mt-4 flex flex-wrap items-center gap-2">
          {caseState === "running" ? (
            <Button variant="outline" className="min-h-11" onClick={() => endCase(false)}>
              <Square className="size-4" /> End case
            </Button>
          ) : (
            <Button className="min-h-11" onClick={() => void startCase("muse")}>
              <Bluetooth className="size-4" /> Start case · {meta.caseCode || "new code"}
            </Button>
          )}
          {/* Nothing reaches the dashboard until the recording is filed. */}
          {caseState === "ended" && hasUnfiledData && !testing && !saved ? (
            <Button
              variant="secondary"
              className="min-h-11"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              <Save className="size-4" /> {saving ? "Filing…" : "File case"}
            </Button>
          ) : null}
          <Button asChild variant="ghost" className="min-h-11">
            <Link to="/">Full monitor</Link>
          </Button>
          {caseState !== "idle" ? (
            <span className="metric-value text-xs text-muted-foreground">
              {testing
                ? "Test session — nothing is recorded"
                : saved
                  ? "Filed to the timeline"
                  : caseState === "running"
                    ? `Recording · ${monitor.epochs.length} readings`
                    : "Ended, not yet filed"}
            </span>
          ) : null}
        </section>

      </main>
    </div>
  );
}
