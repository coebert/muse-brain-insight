import { Radio } from "lucide-react";

import type { SignalQuality } from "@/lib/eeg/dsp";
import { cn } from "@/lib/utils";

interface Props {
  quality: SignalQuality | null;
  channels: readonly string[];
  channelQuality: Record<string, SignalQuality>;
  usableFraction: number;
}

const gradeClass: Record<SignalQuality["grade"], string> = {
  good: "text-signal",
  fair: "text-caution",
  poor: "text-critical",
};

const gradeBg: Record<SignalQuality["grade"], string> = {
  good: "bg-signal",
  fair: "bg-caution",
  poor: "bg-critical",
};

function Bar({ label, value, display }: { label: string; value: number; display: string }) {
  const tone = value < 0.34 ? "bg-signal" : value < 0.67 ? "bg-caution" : "bg-critical";
  return (
    <div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="metric-value">{display}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all duration-500", tone)}
          style={{ width: `${Math.max(2, Math.min(1, value) * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function SignalQualityPanel({ quality, channels, channelQuality, usableFraction }: Props) {
  return (
    <div className="panel px-4 py-4">
      <div className="flex items-center gap-2">
        <Radio className={cn("size-4", quality ? gradeClass[quality.grade] : "text-muted-foreground")} />
        <h2 className="text-sm font-semibold">Signal quality</h2>
        <span
          className={cn(
            "metric-value ml-auto text-xs uppercase",
            quality ? gradeClass[quality.grade] : "text-muted-foreground",
          )}
        >
          {quality ? `${quality.grade} · ${(quality.score * 100).toFixed(0)} %` : "—"}
        </span>
      </div>

      {quality ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Bar
              label="Muscle / EMG"
              value={quality.emgIndex / 0.5}
              display={`${(quality.emgIndex * 100).toFixed(0)} %`}
            />
            <Bar
              label="Movement steps"
              value={quality.jumpRate / 5}
              display={`${quality.jumpRate.toFixed(1)} /s`}
            />
            <Bar
              label="Saturation"
              value={quality.clipFraction * 8}
              display={`${(quality.clipFraction * 100).toFixed(1)} %`}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {channels.map((c) => {
              const q = channelQuality[c];
              return (
                <span
                  key={c}
                  title={q ? q.reasons.join(" · ") || "Clean signal" : "No data"}
                  className="metric-value flex items-center gap-1.5 rounded bg-muted/50 px-1.5 py-1 text-[10px]"
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      q ? gradeBg[q.grade] : "bg-muted-foreground",
                    )}
                  />
                  {c}
                  <span className="text-muted-foreground">
                    {q ? `${(q.score * 100).toFixed(0)}%` : "—"}
                  </span>
                </span>
              );
            })}
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            {quality.reasons.length
              ? quality.reasons.join(" · ")
              : "Clean epoch — metrics reported at full confidence."}{" "}
            {(usableFraction * 100).toFixed(0)} % of the session has been usable.
          </p>
        </>
      ) : (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Quality checks run once streaming starts.
        </p>
      )}
    </div>
  );
}