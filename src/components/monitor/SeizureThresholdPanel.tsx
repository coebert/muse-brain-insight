/**
 * Applied seizure thresholds for the current acquisition lineage.
 *
 * The seizure detector is validated on a particular montage. On a reduced or
 * unfamiliar setup the gate stiffens the bar or withholds alerting entirely.
 * This panel states, before any analysis is read, exactly which
 * seizureThreshold and seizureEpochs values are in force and why they differ
 * from the configured values.
 */
import { Cpu, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";

import {
  getActiveDeviceProfile,
  type DeviceProfile,
} from "@/lib/eeg/device-profile";
import {
  describeLineage,
  gateSeizureDetector,
  lineageFromProfile,
  type GateMode,
  type SeizureGate,
} from "@/lib/eeg/model-lineage";
import { cn } from "@/lib/utils";

const MODE_LABEL: Record<GateMode, string> = {
  run: "Validated thresholds in force",
  provisional: "Stiffened thresholds in force",
  blocked: "Alerting held off",
};

const MODE_TONE: Record<GateMode, string> = {
  run: "bg-signal/15 text-signal",
  provisional: "bg-caution/15 text-caution",
  blocked: "bg-destructive/15 text-destructive",
};

const MODE_ICON = {
  run: ShieldCheck,
  provisional: ShieldAlert,
  blocked: ShieldX,
} as const;

function Value({
  label,
  configured,
  applied,
  format,
}: {
  label: string;
  configured: number;
  applied: number;
  format: (n: number) => string;
}) {
  const changed = Math.abs(applied - configured) > 1e-9;
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="metric-value text-base">{format(applied)}</p>
      <p className="text-[11px] text-muted-foreground">
        {changed ? `configured ${format(configured)} → applied ${format(applied)}` : "unchanged from configured value"}
      </p>
    </div>
  );
}

export interface SeizureThresholdPanelProps {
  /** Configured detector settings, before the montage gate. */
  configured: { seizureThreshold: number; seizureEpochs: number };
  /** Settings actually handed to the analyzers. */
  applied: { seizureThreshold: number; seizureEpochs: number };
  /** Gate decision; recomputed from the profile when omitted. */
  gate?: SeizureGate;
  profile?: DeviceProfile;
  className?: string;
}

export function SeizureThresholdPanel({
  configured,
  applied,
  gate,
  profile,
  className,
}: SeizureThresholdPanelProps) {
  const device = profile ?? getActiveDeviceProfile();
  const decision = gate ?? gateSeizureDetector(device);
  const Icon = MODE_ICON[decision.mode];

  return (
    <section
      className={cn("panel border border-border px-3 py-3", className)}
      aria-label="Applied seizure thresholds for this lineage"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Applied seizure thresholds
        </h3>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Cpu className="size-3.5" aria-hidden /> {describeLineage(lineageFromProfile(device))}
        </p>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
            MODE_TONE[decision.mode],
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {MODE_LABEL[decision.mode]}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Value
          label="seizureThreshold"
          configured={configured.seizureThreshold}
          applied={applied.seizureThreshold}
          format={(n) => n.toFixed(2)}
        />
        <Value
          label="seizureEpochs"
          configured={configured.seizureEpochs}
          applied={applied.seizureEpochs}
          format={(n) => `${Math.round(n)}`}
        />
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">{decision.headline}</p>
      {decision.reasons.length ? (
        <ul className="mt-1 space-y-0.5">
          {decision.reasons.map((r) => (
            <li key={r} className="text-[11px] text-muted-foreground">
              · {r}
            </li>
          ))}
        </ul>
      ) : null}
      {decision.action ? (
        <p className="mt-1 text-[11px] text-foreground/80">Next: {decision.action}</p>
      ) : null}
      {decision.mode === "blocked" ? (
        <p className="mt-1 text-[11px] text-destructive">
          Scores are still computed for review, but no seizure alert is raised on this setup.
        </p>
      ) : null}
    </section>
  );
}
