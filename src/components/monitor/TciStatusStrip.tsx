import { Syringe } from "lucide-react";

import { describeTargets, tciModel, type TciInfusion } from "@/lib/eeg/tci";
import { formatClock } from "@/lib/eeg/format";

/**
 * Always-visible read-out of what is actually running, so the regimen never
 * disappears behind a tab while the DSA is being watched.
 */
export function TciStatusStrip({
  infusions,
  onOpen,
}: {
  infusions: TciInfusion[];
  onOpen: () => void;
}) {
  const live = infusions.filter((i) => i.stoppedAt === null);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-11 w-full items-center gap-2 overflow-x-auto rounded-md border border-border bg-card/60 px-3 py-1.5 text-left"
    >
      <Syringe className="size-4 shrink-0 text-signal" />
      {live.length === 0 ? (
        <span className="text-xs text-muted-foreground">No TCI running — tap to add a pump</span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {live.map((inf) => {
            const model = tciModel(inf.modelKey);
            const last = inf.changes?.[inf.changes.length - 1];
            return (
              <span key={inf.id} className="text-xs whitespace-nowrap text-foreground">
                <span className="font-medium">{model?.label ?? inf.modelKey}</span>{" "}
                <span className="metric-value text-signal">
                  {model ? describeTargets(model, inf.targets) : ""}
                </span>
                {last ? (
                  <span className="ml-1 text-muted-foreground">
                    (last change {formatClock(last.t)})
                  </span>
                ) : null}
              </span>
            );
          })}
        </span>
      )}
    </button>
  );
}
