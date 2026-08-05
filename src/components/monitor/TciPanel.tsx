import { useState } from "react";
import { Minus, Plus, Syringe, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TCI_MODELS,
  clampCe,
  defaultTargets,
  describeTargets,
  formatCe,
  tciModel,
  type TciInfusion,
  type TciDrugSpec,
} from "@/lib/eeg/tci";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

/**
 * Contemporaneous record of the TCI pumps running for this case. Several
 * infusions can run at once (e.g. propofol plus remifentanil); every start,
 * target change and stop is timestamped into the session timeline so the AI
 * interpreter can align drug effect with the EEG.
 */
export function TciPanel({
  infusions,
  onChange,
  running,
  elapsed,
  onMark,
}: {
  infusions: TciInfusion[];
  onChange: (next: TciInfusion[]) => void;
  running: boolean;
  elapsed: number;
  onMark: (detail: string) => void;
}) {
  const [pick, setPick] = useState<string>(TCI_MODELS[0]?.key ?? "eleveld_propofol");

  const live = infusions.filter((i) => i.stoppedAt === null);

  function startInfusion() {
    const model = tciModel(pick);
    if (!model) return;
    const targets = defaultTargets(model);
    const infusion: TciInfusion = {
      id: `${pick}-${Date.now()}`,
      modelKey: pick,
      targets,
      startedAt: elapsed,
      stoppedAt: null,
    };
    onChange([...infusions, infusion]);
    onMark(`TCI start — ${model.short}: Ce ${describeTargets(model, targets)}`);
  }

  function setTarget(infusion: TciInfusion, drug: TciDrugSpec, next: number) {
    const model = tciModel(infusion.modelKey);
    if (!model) return;
    const value = clampCe(next, drug);
    const prev = infusion.targets[drug.key] ?? 0;
    if (value === prev) return;
    onChange(
      infusions.map((i) =>
        i.id === infusion.id
          ? { ...i, targets: { ...i.targets, [drug.key]: value }, lastChangeAt: elapsed }
          : i,
      ),
    );
    onMark(
      `TCI ${model.short} — ${drug.label} Ce ${formatCe(prev, drug)} → ${formatCe(value, drug)}`,
    );
  }

  function stopInfusion(infusion: TciInfusion) {
    const model = tciModel(infusion.modelKey);
    onChange(infusions.map((i) => (i.id === infusion.id ? { ...i, stoppedAt: elapsed } : i)));
    if (model) onMark(`TCI stop — ${model.short}`);
  }

  return (
    <div className="border-t border-border px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <Syringe className="size-3.5" /> TCI pumps
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger className="h-9 w-full text-xs sm:w-[16rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TCI_MODELS.map((m) => (
                <SelectItem key={m.key} value={m.key} className="text-xs">
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="secondary" disabled={!running} onClick={startInfusion}>
            Add pump
          </Button>
        </div>
      </div>

      {live.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No TCI running. Add a pump to record the model and effect-site target; changes are
          timestamped against the case clock and read by the AI interpreter.
        </p>
      ) : (
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {live.map((infusion) => (
            <InfusionCard
              key={infusion.id}
              infusion={infusion}
              running={running}
              onSetTarget={setTarget}
              onStop={stopInfusion}
            />
          ))}
        </div>
      )}

      {infusions.some((i) => i.stoppedAt !== null) ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {infusions
            .filter((i) => i.stoppedAt !== null)
            .map((i) => {
              const model = tciModel(i.modelKey);
              return (
                <span
                  key={i.id}
                  className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground"
                >
                  {model?.short} stopped {formatClock(i.stoppedAt ?? 0)}
                </span>
              );
            })}
        </div>
      ) : null}
    </div>
  );
}

function InfusionCard({
  infusion,
  running,
  onSetTarget,
  onStop,
}: {
  infusion: TciInfusion;
  running: boolean;
  onSetTarget: (infusion: TciInfusion, drug: TciDrugSpec, next: number) => void;
  onStop: (infusion: TciInfusion) => void;
}) {
  const model = tciModel(infusion.modelKey);
  if (!model) return null;
  return (
    <div className="rounded-md border border-border bg-card/60 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-foreground">{model.label}</span>
        <span className="metric-value text-xs text-muted-foreground">
          from {formatClock(infusion.startedAt)}
        </span>
        <button
          type="button"
          aria-label={`Stop ${model.short}`}
          className="ml-auto flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:text-critical"
          onClick={() => onStop(infusion)}
        >
          <X className="size-3.5" /> Stop
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {model.drugs.map((drug) => (
          <CeRow
            key={drug.key}
            drug={drug}
            value={infusion.targets[drug.key] ?? 0}
            running={running}
            onCommit={(next) => onSetTarget(infusion, drug, next)}
          />
        ))}
      </div>
    </div>
  );
}

/** One drug's effect-site target, adjustable in pump steps or typed directly. */
function CeRow({
  drug,
  value,
  running,
  onCommit,
}: {
  drug: TciDrugSpec;
  value: number;
  running: boolean;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Number(value.toFixed(3)));
  const dirty = draft !== null && clampCe(Number(draft), drug) !== value;

  function commit(next: number) {
    setDraft(null);
    onCommit(next);
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{drug.label}</span>
      <Button
        size="icon"
        variant="outline"
        className="size-9 shrink-0"
        aria-label={`Decrease ${drug.label} target`}
        disabled={!running || value <= 0}
        onClick={() => commit(value - drug.step)}
      >
        <Minus className="size-4" />
      </Button>
      <Input
        inputMode="decimal"
        aria-label={`${drug.label} effect-site target in ${drug.unit}`}
        className={cn("metric-value h-9 w-20 text-center text-sm", dirty && "border-marker")}
        value={shown}
        disabled={!running}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => (draft === null ? undefined : commit(Number(draft)))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft !== null) commit(Number(draft));
        }}
      />
      <Button
        size="icon"
        variant="outline"
        className="size-9 shrink-0"
        aria-label={`Increase ${drug.label} target`}
        disabled={!running || value >= drug.max}
        onClick={() => commit(value + drug.step)}
      >
        <Plus className="size-4" />
      </Button>
      <span className="text-xs text-muted-foreground">{drug.unit}</span>
    </div>
  );
}
