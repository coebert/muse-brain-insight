/**
 * Acquisition setup and detector eligibility.
 *
 * Every fitted model and validated threshold in the app belongs to a
 * particular acquisition setup — device, electrode positions, sample rate. On
 * a different setup some detectors still hold, some run with a stiffened bar,
 * and some are withheld. This panel states the setup now streaming and, for
 * each detector, whether it is running, provisional or held off, with the
 * reason and what to do about it.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, CircleSlash, Cpu, TriangleAlert } from "lucide-react";

import {
  ANALYSIS_CHANNELS,
  ANALYSIS_SAMPLE_RATE,
  CHANNEL_REGION,
  getActiveDeviceProfile,
  isBilateral,
  type DeviceProfile,
} from "@/lib/eeg/device-profile";
import { getBisDrift } from "@/lib/eeg/bis-drift.functions";
import {
  activeLineageKey,
  describeLineage,
  gateSeizureDetector,
  lineageFromProfile,
  MIN_USABLE_SAMPLE_RATE,
  type GateMode,
} from "@/lib/eeg/model-lineage";
import { guardCoebisRuntime } from "@/lib/eeg/runtime-guard";
import { cn } from "@/lib/utils";

type Row = {
  key: string;
  name: string;
  mode: GateMode;
  headline: string;
  reasons: string[];
  action: string;
};

const MODE_LABEL: Record<GateMode, string> = {
  run: "Enabled",
  provisional: "Provisional",
  blocked: "Held off",
};

const MODE_TONE: Record<GateMode, string> = {
  run: "bg-signal/15 text-signal",
  provisional: "bg-caution/15 text-caution",
  blocked: "bg-destructive/15 text-destructive",
};

const MODE_ICON = {
  run: CheckCircle2,
  provisional: TriangleAlert,
  blocked: CircleSlash,
} as const;

function DetectorRow({ row }: { row: Row }) {
  const Icon = MODE_ICON[row.mode];
  return (
    <li className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex items-center gap-2 text-xs font-medium">
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              row.mode === "run"
                ? "text-signal"
                : row.mode === "provisional"
                  ? "text-caution"
                  : "text-destructive",
            )}
            aria-hidden
          />
          {row.name}
        </span>
        <span
          className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide", MODE_TONE[row.mode])}
        >
          {MODE_LABEL[row.mode]}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{row.headline}</p>
      {row.reasons.length ? (
        <ul className="mt-1 space-y-0.5">
          {row.reasons.map((r) => (
            <li key={r} className="text-[11px] text-muted-foreground">
              · {r}
            </li>
          ))}
        </ul>
      ) : null}
      {row.action ? (
        <p className="mt-1 text-[11px] text-foreground/80">Next: {row.action}</p>
      ) : null}
    </li>
  );
}

export interface AcquisitionLineagePanelProps {
  /** Setup currently streaming; defaults to the active device profile. */
  profile?: DeviceProfile;
  className?: string;
}

export function AcquisitionLineagePanel({ profile, className }: AcquisitionLineagePanelProps) {
  const device = profile ?? getActiveDeviceProfile();
  const lineage = lineageFromProfile(device);
  const fetchDrift = useServerFn(getBisDrift);

  const { data } = useQuery({
    queryKey: ["bis-drift"],
    queryFn: () => fetchDrift({ data: { lineage: activeLineageKey() } }),
    staleTime: 60_000,
  });

  const seizure = gateSeizureDetector(device);
  const coebisGate = data?.gate ?? null;
  const active = data?.active ?? null;
  /**
   * Schema check on the model itself, run before it is allowed to correct a
   * live depth index. A malformed or mislabelled model is held off even when
   * the montage would otherwise permit it.
   */
  const coebisSchema = guardCoebisRuntime(
    active
      ? {
          modelVersion: active.modelVersion,
          modelFamily: active.modelFamily,
          lineageKey: active.lineage,
          gain: active.gain,
          offset: active.offset,
          knots: active.knots,
          terms: active.terms,
          nPoints: active.nPoints,
          nSessions: active.nSessions,
        }
      : null,
    { profile: device },
  );
  const bilateral = isBilateral(device);
  const rateOk = device.sampleRate >= MIN_USABLE_SAMPLE_RATE;

  const rows: Row[] = [
    {
      key: "coebis",
      name: "COEBIS depth index",
      mode:
        coebisSchema.status === "blocked"
          ? "blocked"
          : coebisGate
            ? coebisGate.mode
            : "blocked",
      headline: coebisSchema.status === "blocked"
        ? coebisSchema.headline
        : coebisGate
        ? coebisGate.headline
        : "No fitted COEBIS model applies to this setup — the published open index is shown instead.",
      reasons:
        coebisSchema.status === "blocked"
          ? coebisSchema.issues
          : [...(coebisGate?.comparison.reasons ?? []), ...coebisSchema.warnings],
      action:
        (coebisSchema.status === "blocked"
          ? "Refit COEBIS on this setup — the stored model cannot be validated against the current schema."
          : coebisGate?.action) ??
        "Enter paired commercial BIS readings on this device to fit a model for it.",
    },
    {
      key: "seizure",
      name: "Seizure detection",
      mode: seizure.mode,
      headline:
        seizure.headline +
        (seizure.mode === "provisional" && seizure.thresholdDelta > 0
          ? ` (score threshold +${seizure.thresholdDelta.toFixed(2)}${seizure.extraEpochs ? `, +${seizure.extraEpochs} epoch` : ""})`
          : ""),
      reasons: seizure.reasons,
      action: seizure.action,
    },
    {
      key: "suppression",
      name: "Burst suppression ratio",
      mode: rateOk ? "run" : "blocked",
      headline: rateOk
        ? "Amplitude-based suppression scoring does not depend on montage width and runs on any populated electrode."
        : `Native rate ${Math.round(device.sampleRate)} Hz cannot resolve the suppression amplitude floor.`,
      reasons: [],
      action: rateOk ? "" : `Use a device sampling at ${MIN_USABLE_SAMPLE_RATE} Hz or above.`,
    },
    {
      key: "asymmetry",
      name: "Bilateral asymmetry & coherence adjunct",
      mode: bilateral ? "run" : "blocked",
      headline: bilateral
        ? "Both hemispheres are populated, so side-to-side terms have real input."
        : "Only one hemisphere is populated; asymmetry and interhemispheric coherence are not computed.",
      reasons: [],
      action: bilateral ? "" : "Add at least one electrode on the opposite hemisphere.",
    },
  ];

  return (
    <section
      className={cn("panel border border-border px-3 py-3", className)}
      aria-label="Acquisition setup and detector eligibility"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Setup lineage & detector eligibility
        </h3>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Cpu className="size-3.5" aria-hidden /> {describeLineage(lineage)}
        </p>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {ANALYSIS_CHANNELS.map((c) => {
          const present = lineage.channels.includes(c);
          return (
            <div
              key={c}
              className={cn(
                "rounded-md px-2 py-1.5",
                present ? "bg-signal/10" : "bg-muted/40 opacity-70",
              )}
            >
              <p className="metric-value text-xs">{c}</p>
              <p className="text-[11px] text-muted-foreground">
                {present ? CHANNEL_REGION[c] : "not populated"}
              </p>
            </div>
          );
        })}
      </div>

      <p className="mb-2 text-[11px] text-muted-foreground">
        Sampled at {Math.round(device.sampleRate)} Hz, resampled to {ANALYSIS_SAMPLE_RATE} Hz for
        analysis. Detectors are compared against the setup they were calibrated or validated on.
      </p>

      <ul className="space-y-2">
        {rows.map((r) => (
          <DetectorRow key={r.key} row={r} />
        ))}
      </ul>
    </section>
  );
}
