import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  DELIRIUM_OPTIONS,
  EMERGENCE_OPTIONS,
  EMPTY_OUTCOME,
  type CaseOutcome,
  type OutcomeCase,
} from "@/lib/eeg/outcomes";
import { saveCaseOutcome } from "@/lib/eeg/outcomes.functions";

interface Props {
  outcomeCase: OutcomeCase;
  onSaved?: () => void;
}

/** Post-case record: what happened to the patient after the anaesthetic. */
export function OutcomeEntryPanel({ outcomeCase, onSaved }: Props) {
  const [form, setForm] = useState<Omit<CaseOutcome, "sessionId">>(
    outcomeCase.outcome ?? { ...EMPTY_OUTCOME },
  );
  const save = useServerFn(saveCaseOutcome);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          sessionId: outcomeCase.sessionId,
          delirium: form.delirium,
          deliriumDays: form.deliriumDays,
          emergence: form.emergence,
          awareness: form.awareness,
          unplannedIcu: form.unplannedIcu,
          mortality30d: form.mortality30d,
          lengthOfStayDays: form.lengthOfStayDays,
          notes: form.notes,
        },
      }),
    onSuccess: () => {
      toast.success("Outcome recorded");
      void queryClient.invalidateQueries({ queryKey: ["outcome-report"] });
      onSaved?.();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the outcome."),
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1 text-xs font-medium tracking-wide uppercase">
          Postoperative delirium
        </legend>
        <div className="flex flex-wrap gap-2">
          {DELIRIUM_OPTIONS.map((o) => (
            <Button
              key={o.key}
              type="button"
              size="sm"
              variant={form.delirium === o.key ? "default" : "outline"}
              className="min-h-11 sm:min-h-9"
              onClick={() => set("delirium", o.key)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-xs font-medium tracking-wide uppercase">Emergence</legend>
        <div className="flex flex-wrap gap-2">
          {EMERGENCE_OPTIONS.map((o) => (
            <Button
              key={o.key}
              type="button"
              size="sm"
              variant={form.emergence === o.key ? "default" : "outline"}
              className="min-h-11 sm:min-h-9"
              onClick={() => set("emergence", o.key)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`delirium-days-${outcomeCase.sessionId}`} className="text-xs">
            Days of delirium
          </Label>
          <Input
            id={`delirium-days-${outcomeCase.sessionId}`}
            inputMode="numeric"
            className="h-11 sm:h-9"
            value={form.deliriumDays ?? ""}
            onChange={(e) =>
              set("deliriumDays", e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </div>
        <div>
          <Label htmlFor={`los-${outcomeCase.sessionId}`} className="text-xs">
            Length of stay (days)
          </Label>
          <Input
            id={`los-${outcomeCase.sessionId}`}
            inputMode="numeric"
            className="h-11 sm:h-9"
            value={form.lengthOfStayDays ?? ""}
            onChange={(e) =>
              set("lengthOfStayDays", e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {(
          [
            ["awareness", "Reported awareness"],
            ["unplannedIcu", "Unplanned ICU admission"],
            ["mortality30d", "Died within 30 days"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <Switch checked={form[key]} onCheckedChange={(v) => set(key, v)} />
            {label}
          </label>
        ))}
      </div>

      <div>
        <Label htmlFor={`outcome-notes-${outcomeCase.sessionId}`} className="text-xs">
          Notes
        </Label>
        <Textarea
          id={`outcome-notes-${outcomeCase.sessionId}`}
          rows={2}
          value={form.notes ?? ""}
          onChange={(e) => set("notes", e.target.value || null)}
          placeholder="Anything about recovery worth cross-referencing with the EEG."
        />
      </div>

      <Button
        size="sm"
        className="min-h-11 sm:min-h-9"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        Save outcome
      </Button>
    </div>
  );
}
