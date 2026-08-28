import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

import type { DiagnosticExportCheck } from "@/lib/eeg/export-schema";

const LEVEL_STYLE = {
  ready: { className: "border-signal/40 bg-signal/10 text-signal", Icon: CheckCircle2 },
  partial: { className: "border-caution/40 bg-caution/10 text-caution", Icon: AlertTriangle },
  invalid: { className: "border-critical/40 bg-critical/10 text-critical", Icon: XCircle },
} as const;

export interface DecoderReadyBadgeProps {
  check: DiagnosticExportCheck;
  /** Short context line, e.g. the file that was checked. */
  label?: string;
}

/**
 * Instant verdict on a diagnostic capture: does it match the export schema,
 * and can the production decoder actually be re-run against it? The embedded
 * patient-safe metadata is shown alongside so sessions can be compared.
 */
export function DecoderReadyBadge({ check, label }: DecoderReadyBadgeProps) {
  const { className, Icon } = LEVEL_STYLE[check.level];
  const meta = check.meta;
  return (
    <div className={`rounded-md border p-2 text-[11px] ${className}`} role="status">
      <p className="flex items-center gap-2 font-medium">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {check.summary}
        {label ? <span className="font-normal opacity-80">· {label}</span> : null}
      </p>
      {meta ? (
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-foreground/80 sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Exported</dt>
            <dd className="tabular-nums">{meta.exportedAt.replace("T", " ").slice(0, 19)}Z</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Device</dt>
            <dd className="break-words">
              {meta.device.label}
              {meta.device.firmwareVersion ? ` · fw ${meta.device.firmwareVersion}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Sample rate</dt>
            <dd className="tabular-nums">{meta.sampleRateHz ? `${meta.sampleRateHz} Hz` : "unknown"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Anonymisation tag</dt>
            <dd className="font-mono">{meta.anonymisation.tag}</dd>
          </div>
        </dl>
      ) : null}
      {check.issues.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/80">
          {check.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
