import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { CaseFactsEditor } from "@/components/monitor/CaseFactsEditor";
import { CaseNoteInsightsPanel } from "@/components/monitor/CaseNoteInsightsPanel";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { formatCaseDuration, formatClock, formatDuration } from "@/lib/eeg/format";
import { formatStampInZone, useTimeZonePreference } from "@/lib/eeg/timezone";
import { TimeZoneControl } from "@/components/TimeZoneControl";
import { unseal } from "@/lib/privacy";

export const Route = createFileRoute("/_authenticated/cases")({
  head: () => ({
    meta: [
      { title: "Case handover — CortexTrace" },
      {
        name: "description",
        content:
          "Handover view of recent and in-progress EEG cases: last depth index, suppression burden and alerts still needing attention.",
      },
      { property: "og:title", content: "Case handover — CortexTrace" },
      {
        property: "og:description",
        content: "Recent and in-progress EEG cases with outstanding alerts at a glance.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Cases,
});

const CONTEXT_LABELS: Record<string, string> = {
  general_anaesthesia: "General anaesthesia",
  icu_sedation: "ICU sedation",
  procedural_sedation: "Procedural sedation",
  other: "Other",
};

interface CaseRow {
  id: string;
  case_code: string;
  context: string | null;
  location: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  mean_suppression_ratio: number | null;
  max_suppression_ratio: number | null;
  suppression_seconds: number | null;
  seizure_alerts: number | null;
  lastDepth: number | null;
  lastSr: number | null;
  criticalEvents: number;
  handledAlerts: number;
}

function Cases() {
  const { zone } = useTimeZonePreference();
  const { data, isLoading } = useQuery({
    queryKey: ["case_handover"],
    queryFn: async (): Promise<CaseRow[]> => {
      const { data: sessions, error } = await supabase
        .from("eeg_sessions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      const opened = await unseal(sessions ?? [], ["case_code", "location", "notes"]);
      const ids = opened.map((s) => s.id);

      const [events, actions] = await Promise.all([
        ids.length
          ? supabase.from("eeg_events").select("session_id, severity").in("session_id", ids)
          : Promise.resolve({ data: [] as { session_id: string; severity: string }[] }),
        ids.length
          ? supabase.from("ai_alert_actions").select("session_id").in("session_id", ids)
          : Promise.resolve({ data: [] as { session_id: string | null }[] }),
      ]);

      const rows = await Promise.all(
        opened.map(async (s) => {
          const { data: last } = await supabase
            .from("eeg_epochs")
            .select("depth_index, suppression_ratio")
            .eq("session_id", s.id)
            .order("t_offset_seconds", { ascending: false })
            .limit(1);
          const tail = last?.[0];
          return {
            ...s,
            lastDepth:
              tail?.depth_index === null || tail === undefined ? null : Number(tail.depth_index),
            lastSr: tail === undefined ? null : Number(tail.suppression_ratio ?? 0),
            criticalEvents: (events.data ?? []).filter(
              (e) =>
                e.session_id === s.id && (e.severity === "critical" || e.severity === "warning"),
            ).length,
            handledAlerts: (actions.data ?? []).filter((a) => a.session_id === s.id).length,
          } as CaseRow;
        }),
      );
      return rows;
    },
  });

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
          <AppNav />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-3 py-6 sm:px-4">
        <h1 className="text-xl font-semibold">Case handover</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Most recent cases first — what the incoming clinician needs to see: last depth index,
          suppression burden and alerts still needing a decision.
        </p>
        <TimeZoneControl className="mt-3" />

        <div className="mt-5">
          <CaseFactsEditor />
        </div>

        <div className="mt-5">
          <CaseNoteInsightsPanel />
        </div>

        <div className="mt-5 space-y-3">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {data && !data.length ? (
            <div className="panel px-4 py-8 text-center text-sm text-muted-foreground">
              No cases filed yet. Start a case on the monitor and file it when you finish.
            </div>
          ) : null}

          {data?.map((c) => {
            const outstanding = Math.max(0, (c.seizure_alerts ?? 0) - c.handledAlerts);
            const inProgress = !c.ended_at;
            return (
              <article key={c.id} className="panel px-4 py-4">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-baseline">
                  <div className="min-w-0">
                    <h2 className="metric-value truncate text-base font-semibold">{c.case_code}</h2>
                    <p className="text-xs text-muted-foreground">
                      {CONTEXT_LABELS[c.context ?? "other"] ?? c.context}
                      {c.location ? ` · ${c.location}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {inProgress ? (
                      <span className="rounded-full bg-signal/15 px-2 py-1 text-xs text-signal">
                        In progress
                      </span>
                    ) : null}
                    {outstanding > 0 ? (
                      <span className="flex items-center gap-1 rounded-full bg-critical/15 px-2 py-1 text-xs text-critical">
                        <AlertTriangle className="size-3.5" /> {outstanding} needing review
                      </span>
                    ) : null}
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3.5" />
                      {formatStampInZone(c.started_at ?? c.created_at, zone)}
                    </span>
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Stat
                    label="Last depth"
                    value={c.lastDepth === null ? "—" : c.lastDepth.toFixed(0)}
                  />
                  <Stat
                    label="Last SR"
                    value={c.lastSr === null ? "—" : `${c.lastSr.toFixed(0)} %`}
                  />
                  <Stat
                    label="Case duration"
                    value={
                      c.ended_at
                        ? formatCaseDuration(c.started_at ?? c.created_at, c.ended_at)
                        : "In progress"
                    }
                    sub={`Monitored ${formatClock(c.duration_seconds ?? 0)}`}
                  />
                  <Stat
                    label="Suppression time"
                    value={formatDuration(c.suppression_seconds ?? 0)}
                  />
                  <Stat label="Alarms logged" value={String(c.criticalEvents)} />
                </dl>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-9">
                    <Link to="/report/$id" params={{ id: c.id }}>
                      Handover report
                    </Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
                    <Link to="/trends">Trends</Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
                    <Link to="/sessions">All records</Link>
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="metric-value mt-0.5 text-base">{value}</dd>
      {sub ? <dd className="text-xs text-muted-foreground">{sub}</dd> : null}
    </div>
  );
}
