import { Radio } from "lucide-react";

import type { SignalQuality } from "@/lib/eeg/dsp";
import type { DepthArtifactReport } from "@/lib/eeg/artifact";
import type { SideDecision } from "@/lib/eeg/side-preference";
import { cn } from "@/lib/utils";

interface Props {
  quality: SignalQuality | null;
  channels: readonly string[];
  channelQuality: Record<string, SignalQuality>;
  usableFraction: number;
  /** Depth-index preprocessing gate for the latest epoch. */
  depthArtifact?: DepthArtifactReport | null;
  /** Share of the depth spectral window currently rejected (0-1). */
  depthGatedFraction?: number | undefined;
  /** Which hemisphere currently feeds depth index, SR and SEF95. */
  analysisSource?: SideDecision | undefined;
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
      <div className="flex justify-between text-xs text-muted-foreground">
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

export function SignalQualityPanel({
  quality,
  channels,
  channelQuality,
  usableFraction,
  depthArtifact,
  depthGatedFraction,
  analysisSource,
}: Props) {
  return (
    <div className="panel px-4 py-4">
      <div className="flex items-center gap-2">
        <Radio
          className={cn("size-4", quality ? gradeClass[quality.grade] : "text-muted-foreground")}
        />
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

      {analysisSource ? (
        <p
          className={cn(
            "mt-2 rounded-md px-2 py-1 text-xs",
            analysisSource.side
              ? "bg-caution/10 text-caution"
              : "bg-muted/50 text-muted-foreground",
          )}
        >
          <span className="font-semibold">
            {analysisSource.side
              ? `Depth index, SR and SEF95 from the ${analysisSource.side} hemisphere`
              : "Depth index, SR and SEF95 from both hemispheres"}
          </span>
          <span className="block">{analysisSource.reason}</span>
        </p>
      ) : null}

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
                  className="metric-value flex items-center gap-1.5 rounded bg-muted/50 px-1.5 py-1 text-xs"
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

          <p className="mt-3 text-xs text-muted-foreground">
            {quality.reasons.length
              ? quality.reasons.join(" · ")
              : "Clean epoch — metrics reported at full confidence."}{" "}
            {(usableFraction * 100).toFixed(0)} % of the session has been usable.
          </p>

          {depthArtifact ? (
            <p className="mt-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
              <span className="text-foreground/80">Depth index input: </span>
              {depthArtifact.usable ? (
                <span className="text-signal">accepted</span>
              ) : (
                <span className="text-caution">rejected — {depthArtifact.reasons.join(" · ")}</span>
              )}
              {typeof depthGatedFraction === "number"
                ? ` · ${(depthGatedFraction * 100).toFixed(0)} % of the 30 s window gated`
                : null}
              {depthArtifact.repairedFraction > 0
                ? ` · ${(depthArtifact.repairedFraction * 100).toFixed(1)} % of samples repaired`
                : null}
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Quality checks run once streaming starts.
        </p>
      )}
    </div>
  );
}
