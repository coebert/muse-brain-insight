import { createFileRoute, Link } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { Bluetooth, Moon, Square, Sun, X } from "lucide-react";

import { AlarmBanner } from "@/components/monitor/AlarmBanner";
import { LiveWaveform } from "@/components/monitor/LiveWaveform";
import { TrendLine } from "@/components/monitor/TrendLine";
import { useCaseSession } from "@/components/monitor/CaseSessionProvider";
import { Button } from "@/components/ui/button";
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

/** Live amplitude of the trace, in the units the connected band actually gives. */
function AmplitudeScale({
  store,
  calibrated,
}: {
  store: WaveformStore;
  calibrated: boolean;
}) {
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const rms = data.length ? Math.sqrt(sum / data.length) : null;
  const unit = calibrated ? "µV" : "a.u.";

  return (
    <div className="rounded-lg border border-border bg-card/60 px-3 py-2.5">
      <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
        Amplitude scale
      </p>
      <p className="metric-value mt-0.5 text-3xl tabular-nums">
        {rms == null ? "—" : rms.toFixed(1)}
        <span className="ml-1 text-base text-muted-foreground">{unit} rms</span>
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        peak {peak ? peak.toFixed(0) : "—"} {unit}
        {calibrated ? " · real microvolts" : " · arbitrary units, this band is not calibrated"}
      </p>
    </div>
  );
}

function BedsidePage() {
  const session = useCaseSession();
  const {
    monitor,
    streaming,
    reconnecting,
    caseState,
    derived,
    latest,
    summary,
    alarms,
    depthWindow,
    startCase,
    endCase,
    dim,
    setDim,
  } = session;

  const profile = monitor.deviceProfile;
  const index = derived.live.depthIndex;
  const state = latest?.depth.state ?? null;
  const tone = state ? depthTone(state) : "default";
  const sr = derived.live.suppressionRatio;
  const trend = monitor.epochs.map((e) => e.depth?.index ?? null);
  const band: [number, number] = [depthWindow.prefs.low, depthWindow.prefs.high];
  const inBand = index != null && index >= band[0] && index <= band[1];

  return (
    <div className={cn("min-h-dvh bg-background", dim && "brightness-[0.55]")}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
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
        <section className="rounded-xl border border-border bg-card/60 px-4 py-5 text-center">
          <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
            Depth index · target {band[0]}–{band[1]}
          </p>
          <p
            className={cn(
              "metric-value mt-1 text-[76px] leading-none tabular-nums sm:text-[104px]",
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
          <p className="mt-1 text-sm text-muted-foreground">
            {state ? DEPTH_STATE_LABEL[state] : "Waiting for signal"}
            {index != null && !inBand ? " · outside target" : ""}
          </p>
          <div className="mt-3">
            <TrendLine
              values={trend}
              min={0}
              max={100}
              color="var(--signal)"
              band={band}
              height={70}
              unit=""
              precision={0}
            />
          </div>
        </section>

        <section className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card/60 px-3 py-2.5">
            <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
              Suppression
            </p>
            <p
              className={cn(
                "metric-value mt-0.5 text-3xl tabular-nums",
                sr != null && sr >= 40
                  ? "text-critical"
                  : sr != null && sr >= 10
                    ? "text-caution"
                    : "text-foreground",
              )}
            >
              {sr == null ? "—" : sr.toFixed(0)}
              <span className="ml-1 text-base text-muted-foreground">%</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {Math.round(summary.suppressionSeconds)} s suppressed this case
            </p>
          </div>

          <AmplitudeScale
            store={monitor.waveformStore}
            calibrated={profile.calibratedAmplitude !== false}
          />

          <div className="rounded-lg border border-border bg-card/60 px-3 py-2.5">
            <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
              Signal quality
            </p>
            <p className="metric-value mt-0.5 text-3xl tabular-nums">
              {derived.live.sqi == null ? "—" : derived.live.sqi}
              <span className="ml-1 text-base text-muted-foreground">%</span>
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {profile.channels.map((c) => (
                <span
                  key={c}
                  className={cn(
                    "metric-value rounded px-1.5 py-0.5 text-xs",
                    monitor.contactOk[c]
                      ? "bg-signal/15 text-signal"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-3 overflow-hidden rounded-lg border border-border bg-card/60">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">Live EEG · last 4 s</h2>
            <span className="metric-value text-xs text-muted-foreground">
              0.5–45 Hz · {profile.calibratedAmplitude !== false ? "±80 µV" : "auto-gained"}
            </span>
          </div>
          <div className="h-[140px] px-2">
            <LiveWaveform
              store={monitor.waveformStore}
              suppressionThresholdUv={monitor.settings.suppressionThresholdUv}
              suppressed={latest?.isSuppressed ?? false}
            />
          </div>
        </section>

        <section className="mt-4 flex flex-wrap gap-2">
          {caseState === "running" ? (
            <Button variant="outline" className="min-h-11" onClick={() => endCase(false)}>
              <Square className="size-4" /> Stop
            </Button>
          ) : (
            <Button
              className="min-h-11"
              onClick={() => void startCase("muse", { asTest: true })}
            >
              <Bluetooth className="size-4" /> Connect headband
            </Button>
          )}
          <Button asChild variant="ghost" className="min-h-11">
            <Link to="/">Full monitor</Link>
          </Button>
        </section>

        <p className="mt-4 text-xs text-muted-foreground">
          This screen streams and displays only — file the case from the full monitor. On a Muse the
          amplitude is in real microvolts; a Regul8 streams arbitrary units, so its scale is
          relative and the depth index on either band is an extrapolation of a model fitted on
          theatre recordings.
        </p>
      </main>
    </div>
  );
}
