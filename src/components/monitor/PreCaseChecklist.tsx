import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export const CHECKLIST_ITEMS = [
  { key: "contact", label: "Electrode contact checked" },
  { key: "limits", label: "Alarm limits confirmed" },
  { key: "mode", label: "Mode confirmed" },
] as const;

export type ChecklistKey = (typeof CHECKLIST_ITEMS)[number]["key"];

/** Three ticks before streaming; each tick is recorded into the timeline. */
export function PreCaseChecklist({
  checked,
  onToggle,
}: {
  checked: Record<string, boolean>;
  onToggle: (key: ChecklistKey, label: string) => void;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Before streaming
      </p>
      <div className="flex flex-wrap gap-2">
        {CHECKLIST_ITEMS.map((item) => {
          const on = !!checked[item.key];
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(item.key, item.label)}
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-full border px-3 text-xs font-medium",
                on ? "border-signal/60 bg-signal/10 text-signal" : "border-border text-foreground",
              )}
            >
              <Check className={cn("size-4", on ? "opacity-100" : "opacity-30")} />
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
