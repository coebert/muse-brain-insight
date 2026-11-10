import { FlaskConical } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  EVIDENCE_LABEL,
  VALIDATION_REGISTRY,
  isHumanEvidence,
  type ValidationTask,
} from "@/lib/eeg/validation-registry";

/** Small chip naming the kind of evidence behind one task. */
export function ValidationBadge({ task, className }: { task: ValidationTask; className?: string }) {
  const entry = VALIDATION_REGISTRY[task];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        isHumanEvidence(entry.evidence)
          ? "border-border bg-muted/40 text-muted-foreground"
          : "border-caution/50 bg-caution/10 text-caution",
        className,
      )}
      title={entry.notShown}
    >
      <FlaskConical className="size-3" aria-hidden />
      {EVIDENCE_LABEL[entry.evidence]}
    </span>
  );
}

/** Every task, its evidence kind, and what that evidence does not show. */
export function ValidationRegistryPanel({ className }: { className?: string }) {
  return (
    <section className={cn("panel px-3 py-3 sm:px-4", className)}>
      <h2 className="text-sm font-semibold">What each result has been checked against</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        These are separate tasks; evidence for one does not carry over to another. Nothing here
        has been prospectively validated, and none of it is a claim to outperform BIS.
      </p>
      <ul className="mt-3 space-y-2">
        {Object.values(VALIDATION_REGISTRY).map((e) => (
          <li key={e.task} className="rounded-md border border-border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{e.label}</span>
              <ValidationBadge task={e.task} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{e.basis}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Does not show: </span>
              {e.notShown}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
