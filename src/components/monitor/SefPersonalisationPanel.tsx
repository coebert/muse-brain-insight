import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, UserCog } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { syncSefAlignment } from "@/lib/eeg/sef-alignment";
import {
  clearSefPersonalisation,
  getSefPersonalisation,
} from "@/lib/eeg/sef-personalisation.functions";
import { cn } from "@/lib/utils";

const groupLabel: Record<string, string> = {
  age: "Age",
  sex: "Sex",
  regimen: "Regimen",
  chronic_cns: "Chronic CNS disease",
  acute: "Acute pathology",
};

/**
 * Patient-level personalisation of the spectral edge correction: what the app
 * has learned, how it was validated, and why it is or is not switched on.
 */
export function SefPersonalisationPanel() {
  const fetchReport = useServerFn(getSefPersonalisation);
  const standDown = useServerFn(clearSefPersonalisation);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["sef-personalisation"],
    queryFn: async () => {
      const report = await fetchReport({ data: undefined });
      await syncSefAlignment();
      if (report.justApplied) toast.success("Personalised SEF correction activated.");
      return report;
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      await standDown({ data: undefined });
      await syncSefAlignment();
    },
    onSuccess: () => {
      toast.success("Personalisation stood down — the pooled SEF correction is in force.");
      void queryClient.invalidateQueries({ queryKey: ["sef-personalisation"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <section className="panel flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking SEF personalisation…
      </section>
    );
  }
  if (error || !data) {
    return (
      <section className="panel p-4 text-xs text-muted-foreground">
        SEF personalisation unavailable right now.
      </section>
    );
  }

  const { active, evidence, gate, candidate } = data;
  const shown = active ?? candidate;

  return (
    <section className="panel space-y-3 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <UserCog className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          SEF personalisation
        </h2>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            active ? "bg-signal/15 text-signal" : "bg-muted text-muted-foreground",
          )}
        >
          {active ? "Active (Muse 2)" : "Pooled correction only"}
        </span>
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 text-xs"
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate()}
          >
            Stand down
          </Button>
        ) : null}
      </header>

      <p className="text-xs text-muted-foreground">{data.summary}</p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md bg-muted/40 px-2.5 py-2">
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Paired Muse 2</p>
          <p className="metric-value text-sm">
            {evidence.points.have}/{evidence.points.need}
          </p>
        </div>
        <div className="rounded-md bg-muted/40 px-2.5 py-2">
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Patients</p>
          <p className="metric-value text-sm">
            {evidence.patients.have}/{evidence.patients.need}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {evidence.longitudinalPoints} repeat-visit readings
          </p>
        </div>
        <div className="rounded-md bg-muted/40 px-2.5 py-2">
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Held-out error</p>
          <p className="metric-value text-sm">
            {shown?.cv?.maePersonal != null ? `${shown.cv.maePersonal.toFixed(2)} Hz` : "—"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {shown?.cv?.maePooled != null ? `pooled ${shown.cv.maePooled.toFixed(2)} Hz` : "—"}
          </p>
        </div>
        <div className="rounded-md bg-muted/40 px-2.5 py-2">
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Validation</p>
          <p className="metric-value text-sm">{shown?.cv?.folds ?? 0} folds</p>
          <p className="text-[11px] text-muted-foreground">Grouped by patient</p>
        </div>
      </div>

      {shown?.terms?.length ? (
        <ul className="grid gap-1 text-xs sm:grid-cols-2">
          {shown.terms.map((t) => (
            <li
              key={`${t.group}-${t.level}`}
              className="flex items-center justify-between rounded-md bg-muted/30 px-2.5 py-1.5"
            >
              <span className="text-muted-foreground">
                {groupLabel[t.group] ?? t.group} · {t.level}
              </span>
              <span className="metric-value">
                {t.dy > 0 ? "+" : ""}
                {t.dy.toFixed(2)} Hz
                <span className="ml-1 text-[11px] text-muted-foreground">
                  ({t.n} readings, {t.patients} patients)
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {gate.reasons.length ? (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
          {gate.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
