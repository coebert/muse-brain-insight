import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Waves } from "lucide-react";
import { toast } from "sonner";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { syncSefAlignment } from "@/lib/eeg/sef-alignment";
import { clearSefAlignment, getSefDrift } from "@/lib/eeg/sef-drift.functions";
import { cn } from "@/lib/utils";

const VERDICT_TONE: Record<string, string> = {
  insufficient: "bg-muted text-muted-foreground",
  watching: "bg-caution/15 text-caution",
  provisional: "bg-caution/15 text-caution",
  aligned: "bg-signal/15 text-signal",
  adjust: "bg-caution/15 text-caution",
  adjustment_active: "bg-signal/15 text-signal",
};

const VERDICT_LABEL: Record<string, string> = {
  insufficient: "No paired SEF yet",
  watching: "Watching",
  provisional: "Correction provisional",
  aligned: "SEF tracking monitor",
  adjust: "Correction fitted",
  adjustment_active: "Correction active",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-2">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="metric-value text-sm">{value}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const signed = (v: number | null | undefined, dp = 2, suffix = "") =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${suffix}`;

/**
 * Cross-case surveillance of the headband's spectral edge against SEF values
 * transcribed from the commercial monitor, plus the gain/offset correction the
 * app applies once the difference is consistent across enough cases.
 */
export function SefDriftPanel() {
  const fetchDrift = useServerFn(getSefDrift);
  const clearAlignment = useServerFn(clearSefAlignment);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["sef-drift"],
    queryFn: async () => {
      const report = await fetchDrift({ data: undefined });
      await syncSefAlignment();
      if (report.justApplied) {
        toast.success("Spectral edge re-aligned to your commercial monitor SEF.");
      }
      return report;
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      await clearAlignment({ data: undefined });
      await syncSefAlignment();
    },
    onSuccess: () => {
      toast.success("SEF correction removed — the raw headband edge frequency is shown.");
      void queryClient.invalidateQueries({ queryKey: ["sef-drift"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <section className="panel flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking SEF agreement…
      </section>
    );
  }
  if (error || !data) {
    return (
      <section className="panel p-4 text-xs text-muted-foreground">
        SEF agreement unavailable right now.
      </section>
    );
  }

  const { analysis, active, series } = data;
  const r = analysis.readiness;

  return (
    <section className="panel space-y-3 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <Waves className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Spectral edge alignment
        </h2>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            VERDICT_TONE[analysis.verdict] ?? "bg-muted text-muted-foreground",
          )}
        >
          {VERDICT_LABEL[analysis.verdict] ?? analysis.verdict}
        </span>
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 text-xs"
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate()}
          >
            Show raw SEF
          </Button>
        ) : null}
      </header>

      <p className="text-xs text-muted-foreground">{analysis.summary}</p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Paired SEF"
          value={`${r.points.have}`}
          hint={`${r.sessions.have} case${r.sessions.have === 1 ? "" : "s"}`}
        />
        <Stat
          label="Mean difference"
          value={signed(analysis.bias, 2, " Hz")}
          hint="Headband minus monitor"
        />
        <Stat
          label="Correction"
          value={
            active ? `${active.gain.toFixed(2)}× ${signed(active.offset, 2, " Hz")}` : "none"
          }
          hint={active ? `${active.nPoints} readings` : "Raw SEF displayed"}
        />
        <Stat
          label="Error after fit"
          value={active?.maeAfter != null ? `${active.maeAfter.toFixed(2)} Hz` : "—"}
          hint={active?.maeBefore != null ? `was ${active.maeBefore.toFixed(2)} Hz` : undefined}
        />
      </div>

      {series.length > 1 ? (
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 6, right: 8, bottom: 4, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="i" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
                unit=" Hz"
                width={52}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Line
                name="Monitor SEF"
                type="monotone"
                dataKey="monitorSef"
                stroke="hsl(var(--signal))"
                dot={false}
              />
              <Line
                name="Headband (raw)"
                type="monotone"
                dataKey="raw"
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 3"
                dot={false}
              />
              <Line
                name="Headband (aligned)"
                type="monotone"
                dataKey="corrected"
                stroke="hsl(var(--primary))"
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Enter SEF from the commercial monitor alongside a running case to build the comparison.
        </p>
      )}
    </section>
  );
}