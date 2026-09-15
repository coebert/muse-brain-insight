import { memo, useEffect, useRef, useSyncExternalStore } from "react";

import type { DeviceProfile } from "@/lib/eeg/device-profile";
import { RAW_ARCHIVE_HZ, type RawArchive } from "@/lib/eeg/raw-archive";
import { cn } from "@/lib/utils";

const WINDOW_SECONDS = 4;

interface Props {
  archive: RawArchive;
  profile: DeviceProfile;
  /** Live only while the band is streaming. */
  streaming: boolean;
  contactOk: Record<string, boolean>;
}

/** One electrode's own shape, drawn straight from the band's samples. */
export const Trace = memo(function Trace({
  samples,
  calibrated,
  fallbackGainUv,
}: {
  samples: Float32Array;
  calibrated: boolean;
  fallbackGainUv: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!samples.length) return;

    // Calibrated bands are drawn on a fixed microvolt scale so two electrodes
    // can be compared by eye. A band with arbitrary units is scaled to its own
    // window instead, which shows the shape without implying a voltage.
    let gain = fallbackGainUv;
    if (!calibrated) {
      let peak = 0;
      for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
      gain = peak > 0 ? peak * 1.15 : 1;
    }

    const scale = h / 2 / gain;
    ctx.lineWidth = 1.3 * dpr;
    ctx.strokeStyle = "rgb(34,211,238)";
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const x = (i / Math.max(1, samples.length - 1)) * w;
      const v = Math.max(-gain, Math.min(gain, samples[i]!));
      const y = h / 2 - v * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [samples, calibrated, fallbackGainUv]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
});

/**
 * The headband's own signal, one line per sensor, beside the depth number.
 * Muse shows all four electrodes; a single-sensor band shows its one trace.
 */
export function HeadbandTracePanel({ archive, profile, streaming, contactOk }: Props) {
  // Redraws whenever fresh samples land, without re-rendering the dashboard.
  useSyncExternalStore(archive.subscribe, archive.getVersion, archive.getVersion);

  const channels = profile.channels;
  const calibrated = profile.calibratedAmplitude !== false;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 sm:px-4">
        <h2 className="text-sm font-semibold">{profile.label} signal · last {WINDOW_SECONDS} s</h2>
        <span className="metric-value text-xs text-muted-foreground">
          {calibrated ? "±80 µV" : "arbitrary units, auto-scaled"} · {RAW_ARCHIVE_HZ} Hz
        </span>
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[11px]",
            streaming ? "bg-signal/15 text-signal" : "bg-muted text-muted-foreground",
          )}
        >
          {streaming ? "Live" : "Not streaming"}
        </span>
      </div>

      <div className="divide-y divide-border">
        {channels.map((channel) => {
          const duration = archive.duration(channel);
          const to = duration;
          const from = Math.max(0, to - WINDOW_SECONDS);
          const samples = to > from ? archive.read(channel, from, to) : new Float32Array(0);
          return (
            <div key={channel} className="flex items-center gap-2 px-2 py-1 sm:px-3">
              <span
                className={cn(
                  "metric-value w-14 shrink-0 rounded px-1.5 py-0.5 text-xs",
                  contactOk[channel]
                    ? "bg-signal/15 text-signal"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {channel}
              </span>
              <div className="h-[46px] min-w-0 flex-1">
                {samples.length ? (
                  <Trace samples={samples} calibrated={calibrated} fallbackGainUv={80} />
                ) : (
                  <div className="flex h-full items-center text-xs text-muted-foreground">
                    No signal from this sensor yet
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {channels.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            No headband connected, so there is no signal to draw.
          </p>
        ) : null}
      </div>
    </section>
  );
}
