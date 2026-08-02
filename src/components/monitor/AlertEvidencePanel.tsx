import { useState } from "react";
import { ChevronDown, ChevronRight, Microscope } from "lucide-react";

import type { AlertEvidence } from "@/lib/eeg/interpret.functions";

const DIRECTION_LABEL: Record<string, string> = {
  high: "↑ high",
  low: "↓ low",
  rising: "↗ rising",
  falling: "↘ falling",
  unstable: "∿ unstable",
  normal: "→ within range",
};

function clock(t: number): string {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function windowLabel(e: AlertEvidence): string {
  const a = e.windowStartSeconds;
  const b = e.windowEndSeconds;
  if (a == null && b == null) return "whole session";
  if (a != null && b != null) {
    const dur = Math.max(0, b - a);
    return `${clock(a)}–${clock(b)} (${dur >= 60 ? `${Math.round(dur / 60)} min` : `${Math.round(dur)} s`})`;
  }
  return `from ${clock((a ?? b) as number)}`;
}

/** Shows the top contributing EEG features/metrics behind an AI alert. */
export function AlertEvidencePanel({ evidence }: { evidence?: AlertEvidence[] }) {
  const [open, setOpen] = useState(false);
  if (!evidence?.length) return null;

  return (
    <div className="mt-2 rounded-md border border-border/70 bg-background/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden />
        )}
        <Microscope className="h-3 w-3" aria-hidden />
        Why this alert · {evidence.length} contributing feature{evidence.length > 1 ? "s" : ""}
      </button>

      {open ? (
        <ul className="space-y-2 border-t border-border/70 px-2.5 py-2">
          {evidence.map((e, i) => (
            <li key={`${e.feature}-${i}`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-xs font-medium text-foreground">{e.feature}</span>
                <span className="metric-value text-xs text-foreground">{e.value}</span>
                <span className="metric-value text-[10px] uppercase tracking-wide text-muted-foreground">
                  {DIRECTION_LABEL[e.direction] ?? e.direction}
                </span>
                {e.expected ? (
                  <span className="metric-value text-[10px] text-muted-foreground">
                    vs {e.expected}
                  </span>
                ) : null}
                <span className="metric-value ml-auto text-[10px] text-muted-foreground">
                  {windowLabel(e)}
                </span>
              </div>
              <div
                className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`Contribution ${Math.round(e.weight * 100)}%`}
              >
                <div
                  className="h-full rounded-full bg-marker"
                  style={{ width: `${Math.round(Math.max(0.04, Math.min(1, e.weight)) * 100)}%` }}
                />
              </div>
              {e.note ? (
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{e.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
