import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppNav } from "@/components/AppNav";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { formatCaseDuration, formatClock, formatDuration } from "@/lib/eeg/format";
import { unseal, downloadJson } from "@/lib/privacy";
import { deleteSessionData, exportMyData } from "@/lib/privacy.functions";

export const Route = createFileRoute("/_authenticated/sessions")({
  head: () => ({
    meta: [
      { title: "Saved EEG sessions — CortexTrace" },
      {
        name: "description",
        content:
          "Review anonymised Muse 2 monitoring records: suppression ratio, suppression time and detected seizure events per case.",
      },
      { property: "og:title", content: "Saved EEG sessions — CortexTrace" },
      {
        property: "og:description",
        content:
          "Anonymised depth-of-anaesthesia session records with suppression and seizure summaries.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Sessions,
});

const CONTEXT_LABELS: Record<string, string> = {
  general_anaesthesia: "General anaesthesia",
  icu_sedation: "ICU sedation",
  procedural_sedation: "Procedural sedation",
  other: "Other",
};

function Sessions() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["eeg_sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_sessions")
        .select("*")
        .order("started_at", { ascending: false });
      if (error) throw error;
      return unseal(data, ["case_code", "location", "notes", "admission_diagnosis"]);
    },
  });

  async function remove(id: string) {
    await deleteSessionData({ data: { sessionId: id } });
    void refetch();
  }

  async function exportOne(id: string, caseCode: string) {
    const bundle = await exportMyData({ data: { sessionId: id } });
    downloadJson(`cortextrace-${caseCode.replace(/\W+/g, "-").toLowerCase()}.json`, bundle);
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
          <AppNav />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-3 py-6 sm:px-4">
        <h1 className="text-lg font-semibold">Saved sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Anonymised records only — identified by the case code you entered at save time.
        </p>

        <div className="mt-5 space-y-3">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {data && !data.length ? (
            <div className="panel px-4 py-8 text-center text-sm text-muted-foreground">
              No sessions saved yet. Record a session on the monitor and choose “Save session”.
            </div>
          ) : null}
          {data?.map((s) => (
            <article key={s.id} className="panel px-4 py-4">
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="metric-value text-base font-semibold">{s.case_code}</h2>
                <span className="text-xs text-muted-foreground">
                  {CONTEXT_LABELS[s.context ?? "other"] ?? s.context}
                  {s.location ? ` · ${s.location}` : ""}
                </span>
                <span className="metric-value text-xs text-muted-foreground">
                  {[
                    s.age_years ? `${s.age_years} y` : s.age_band ? `${s.age_band} y` : null,
                    s.sex && s.sex !== "unknown" ? s.sex : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatWhen(s.started_at ?? s.created_at, s.ended_at)}
                </span>
              </div>
              {s.admission_diagnosis ? (
                <p className="mt-2 text-sm">{s.admission_diagnosis}</p>
              ) : null}
              {s.clinical_features?.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.clinical_features.map((f: string) => (
                    <span
                      key={f}
                      className="rounded-full bg-signal/15 px-2 py-0.5 text-xs text-signal"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              ) : null}
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Started" value={formatStamp(s.started_at ?? s.created_at)} />
                <Stat
                  label="Ended"
                  value={s.ended_at ? formatStamp(s.ended_at) : "—"}
                />
                <Stat
                  label="Case duration"
                  value={
                    s.ended_at
                      ? formatCaseDuration(s.started_at ?? s.created_at, s.ended_at)
                      : "In progress"
                  }
                  sub={`Monitored ${formatClock(s.duration_seconds ?? 0)}`}
                />
                <Stat label="Mean SR" value={`${(s.mean_suppression_ratio ?? 0).toFixed(0)} %`} />
                <Stat label="Peak SR" value={`${(s.max_suppression_ratio ?? 0).toFixed(0)} %`} />
                <Stat label="Suppression time" value={formatDuration(s.suppression_seconds ?? 0)} />
                <Stat label="Seizure events" value={String(s.seizure_alerts ?? 0)} />
              </dl>
              {s.notes ? <p className="mt-3 text-sm text-muted-foreground">{s.notes}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-9">
                  <Link to="/report/$id" params={{ id: s.id }}>
                    End-of-case report
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => void exportOne(s.id, s.case_code)}
                >
                  Export
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => void remove(s.id)}
                >
                  Delete
                </Button>
              </div>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="metric-value mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

/** Date and time of day, e.g. "6 Aug 2026, 09:12". */
function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Header stamp: start date and time, with the finish time when known. */
function formatWhen(startIso: string, endIso: string | null): string {
  const start = formatStamp(startIso);
  if (!endIso) return start;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return start;
  const endTime = end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${start} – ${endTime}`;
}
