import { useMemo, useSyncExternalStore } from "react";

import { TrendLine } from "@/components/monitor/TrendLine";
import { ParameterInfo } from "@/components/monitor/ParameterInfo";
import { Trace } from "@/components/monitor/HeadbandTracePanel";
import type { Epoch } from "@/lib/eeg/analysis";
import type { DeviceProfile } from "@/lib/eeg/device-profile";
import type { RawArchive } from "@/lib/eeg/raw-archive";
import { BASELINE_SAMPLES, coebisBaseline, coebisDriftSeries } from "@/lib/eeg/coebis-baseline";
import { alignSeries } from "@/lib/eeg/gaps";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

interface Props {
  epochs: Epoch[];
  /** Seconds since case start (right edge of the trend). */
  elapsed: number;
  windowMinutes: number;
  /** Wall-clock start of the case; enables clock-time tick labels. */
  startedAtMs?: number | null;
  /** Bedside variant: darker plate, tighter chrome. */
  compact?: boolean;
  className?: string;
  /**
   * Live headband signal. When the depth trend has nothing valid to draw
   * (dropout, gating, no usable epochs) the panel shows the raw EEG and the
   * latest signal-quality reading instead of a blank trace.
   */
  archive?: RawArchive | null;
  profile?: DeviceProfile | null;
}

const RAW_FALLBACK_SECONDS = 4;

const TICKS = 4;
/** Vertical span of the drift strip, in COEBIS points either side of baseline. */
const DRIFT_SPAN = 30;

/** Wall-clock (HH:MM) or elapsed (mm:ss) label for a point on the trend. */
function tickLabel(tSeconds: number, startedAtMs: number | null | undefined): string {
  if (startedAtMs != null && Number.isFinite(startedAtMs)) {
    const d = new Date(startedAtMs + Math.max(0, tSeconds) * 1000);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  return formatClock(Math.max(0, tSeconds));
}

/**
 * Live COEBIS trend with a timestamped x-axis. The learned COEBIS index is
 * drawn solid; the uncorrected OpenIBIS index sits behind it so divergence
 * between the two models is visible at a glance.
 */
export function CoebisTrend({
  epochs,
  elapsed,
  windowMinutes,
  startedAtMs,
  compact = false,
  className,
  archive = null,
  profile = null,
}: Props) {
  const windowSeconds = windowMinutes * 60;
  const visible = useMemo(() => epochs.slice(-windowSeconds), [epochs, windowSeconds]);

  // Per-second alignment keeps dropouts as breaks rather than joining across them.
  const coebisTrend = useMemo(
    () =>
      alignSeries<Epoch, number>(
        visible,
        (e) => e.t,
        (e) => e.depth.coebis ?? null,
      ),
    [visible],
  );
  const openTrend = useMemo(
    () =>
      alignSeries<Epoch, number>(
        visible,
        (e) => e.t,
        (e) => e.depth.index ?? null,
      ),
    [visible],
  );

  const latestCoebis = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const v = visible[i]?.depth.coebis;
      if (v != null) return v;
    }
    return null;
  }, [visible]);

  // Baseline is anchored on the whole case, not the visible window, so the drift
  // reading stays stable as the trend scrolls.
  const baseline = useMemo(
    () => coebisBaseline(epochs.map((e) => e.depth.coebis ?? null)),
    [epochs],
  );
  const driftTrend = useMemo(
    () => coebisDriftSeries(coebisTrend, baseline.value),
    [coebisTrend, baseline.value],
  );
  const drift = baseline.delta;
  const driftLabel =
    drift == null ? "—" : `${drift > 0 ? "+" : drift < 0 ? "−" : "±"}${Math.abs(drift).toFixed(0)}`;
  const driftTone =
    drift == null
      ? "text-muted-foreground"
      : Math.abs(drift) >= 15
        ? "text-critical"
        : Math.abs(drift) >= 8
          ? "text-caution"
          : "text-muted-foreground";

  // The depth trace is "flat" when nothing in the window produced a value —
  // dropout, artefact gating or no usable epochs. In that case the raw EEG
  // and the signal-quality reading are shown instead of an empty plot.
  const depthFlat = useMemo(
    () => !coebisTrend.some((v) => v != null) && !openTrend.some((v) => v != null),
    [coebisTrend, openTrend],
  );
  const latestQuality = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const q = visible[i]?.quality;
      if (q) return q;
    }
    return null;
  }, [visible]);

  // Ticks span the plotted window, from the first visible epoch to "now".
  const ticks = useMemo(() => {
    const end = visible.length > 0 ? (visible[visible.length - 1]?.t ?? elapsed) : elapsed;
    const start = visible.length > 0 ? (visible[0]?.t ?? 0) : Math.max(0, end - windowSeconds);
    const span = Math.max(1, end - start);
    return Array.from({ length: TICKS }, (_, i) => tickLabel(start + (span * i) / (TICKS - 1), startedAtMs));
  }, [visible, elapsed, windowSeconds, startedAtMs]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border",
        compact ? "bg-[rgb(8,16,34)]" : "bg-card",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-2 pt-1">
        <span className="flex items-center gap-1 text-xs tracking-[0.16em] text-muted-foreground uppercase">
          COEBIS trend · {windowMinutes} min
          {compact ? null : <ParameterInfo parameter="coebis" />}
        </span>
        <span className="metric-value text-xs text-signal">
          {latestCoebis != null ? Math.round(latestCoebis) : "—"}
        </span>
      </div>
      <div className={compact ? "h-[64px]" : "h-[90px] min-h-[70px]"}>
        {depthFlat ? (
          <div className="flex h-full flex-col justify-center gap-1 px-2 py-1">
            <span className="text-[11px] tracking-[0.14em] text-caution uppercase">
              No valid depth — showing the headband's raw signal
            </span>
            {archive && profile ? (
              <RawFallback archive={archive} profile={profile} />
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              {latestQuality
                ? latestQuality.flat
                  ? "Signal quality: electrode off the skin — no measurable EEG"
                  : `Signal quality: ${latestQuality.grade} · ${Math.round(latestQuality.amplitudeUv)} µV peak-to-peak${
                      latestQuality.reasons.length
                        ? ` · ${latestQuality.reasons.slice(0, 2).join(", ")}`
                        : ""
                    }`
                : "No readings in this window yet"}
            </span>
          </div>
        ) : (
        <div className="relative h-full">
          <TrendLine
            values={coebisTrend}
            min={0}
            max={100}
            band={[40, 60]}
            color="rgb(120,170,255)"
            unit=""
          />
          <div className="pointer-events-none absolute inset-0">
            <TrendLine
              values={openTrend}
              min={0}
              max={100}
              color="rgba(56,214,175,0.45)"
              transparent
              inspectable={false}
            />
          </div>
        </div>
        )}
      </div>
      <div className="flex items-center justify-between px-2 pb-1 text-[11px] text-muted-foreground tabular-nums">
        {ticks.map((label, i) => (
          <span key={`${label}-${i}`}>{label}</span>
        ))}
      </div>
      {/* Drift strip: how far COEBIS has moved from this patient's own baseline. */}
      <div className="border-t border-border/60 px-2 pt-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs tracking-[0.16em] text-muted-foreground uppercase">
            Drift vs baseline
          </span>
          <span className="metric-value text-xs text-muted-foreground">
            {baseline.value != null ? (
              <>
                base {Math.round(baseline.value)} ·{" "}
                <span className={cn("metric-value", driftTone)}>{driftLabel}</span>
              </>
            ) : (
              `establishing baseline ${baseline.samples}/${BASELINE_SAMPLES}`
            )}
          </span>
        </div>
        <div className={compact ? "h-[34px]" : "h-[46px]"}>
          <TrendLine
            values={driftTrend}
            min={-DRIFT_SPAN}
            max={DRIFT_SPAN}
            band={[-5, 5]}
            color="rgb(200,150,255)"
            unit=" pts"
            height={compact ? 34 : 46}
          />
        </div>
      </div>
      <div className="flex items-center gap-3 px-2 pb-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 rounded bg-[rgb(120,170,255)]" /> COEBIS
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 rounded bg-[rgba(56,214,175,0.6)]" /> OpenIBIS
        </span>
      </div>
    </div>
  );
}
