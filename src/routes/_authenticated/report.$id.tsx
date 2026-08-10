import { useMemo } from "react";
import { EPOCH_COLUMNS, EVENT_COLUMNS } from "@/lib/eeg/db-rows";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, Printer } from "lucide-react";

import { SessionDsa } from "@/components/monitor/SessionDsa";
import { DsaLegend } from "@/components/monitor/DsaChart";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { unseal } from "@/lib/privacy";
import { formatCaseDuration, formatClock, formatDuration } from "@/lib/eeg/format";
import { computeCoebis } from "@/lib/eeg/depth";
import { describeCoebisModel, useCoebisModel } from "@/hooks/useCoebisModel";
import { formatStampInZone, useTimeZonePreference } from "@/lib/eeg/timezone";
import { TimeZoneControl } from "@/components/TimeZoneControl";

export const Route = createFileRoute("/_authenticated/report/$id")({
  head: () => ({
    meta: [
      { title: "End-of-case EEG report — CortexTrace" },
      {
        name: "description",
        content:
          "Printable end-of-case summary: whole-session DSA, suppression ratio, SEF95, depth index, alarms and the annotated event log for a single anonymised case.",
      },
      { property: "og:title", content: "End-of-case EEG report — CortexTrace" },
      {
        property: "og:description",
        content:
          "Printable handover summary of a Muse 2 depth-of-anaesthesia monitoring case with DSA and suppression metrics.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CaseReport,
});

const CONTEXT_LABELS: Record<string, string> = {
  general_anaesthesia: "General anaesthesia",
  icu_sedation: "ICU sedation",
  procedural_sedation: "Procedural sedation",
  other: "Other",
};

const SEVERITY_LABEL: Record<string, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-[0.14em] text-muted-foreground uppercase">{label}</dt>
      <dd className="metric-value mt-0.5 text-sm">{value || "—"}</dd>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="panel px-3 py-2">
      <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">{label}</p>
      <p className="metric-value text-base leading-tight">{value}</p>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function CaseReport() {
  const { id } = Route.useParams();
  const {
    zone,
    abbreviation: zoneAbbreviation,
    offsetLabel: zoneOffsetLabel,
  } = useTimeZonePreference();
  // Active COEBIS fit used to re-score this stored case.
  const coebisModel = useCoebisModel();

  const session = useQuery({
    queryKey: ["eeg_sessions", "report", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("eeg_sessions").select("*").eq("id", id).single();
      if (error) throw error;
      const rows = await unseal([data], ["case_code", "location", "notes", "admission_diagnosis"]);
      return rows[0];
    },
  });

  const epochs = useQuery({
    queryKey: ["eeg_epochs", "report", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_epochs")
        .select(EPOCH_COLUMNS)
        .eq("session_id", id)
        .order("t_offset_seconds", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const events = useQuery({
    queryKey: ["eeg_events", "report", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_events")
        .select(EVENT_COLUMNS)
        .eq("session_id", id)
        .order("t_offset_seconds", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const rows = useMemo(
    () =>
      (epochs.data ?? []).map((e) => {
        const ent = (e.entropy ?? null) as { state?: number } | null;
        const depth = e.depth_index === null ? null : Number(e.depth_index);
        return {
          t: Number(e.t_offset_seconds) || 0,
          depth,
          // Back-calculated from the stored open index with the current model.
          coebis: depth === null ? null : computeCoebis(depth),
          sef95: e.spectral_edge_95 === null ? null : Number(e.spectral_edge_95),
          sr: e.suppression_ratio === null ? null : Number(e.suppression_ratio),
          seizure: e.seizure_score === null ? null : Number(e.seizure_score),
          entropy: typeof ent?.state === "number" ? Number((ent.state * 100).toFixed(1)) : null,
          suppressed: e.is_suppressed ? 1 : 0,
        };
      }),
    [epochs.data, coebisModel],
  );

  const spectra = useMemo(
    () =>
      (epochs.data ?? []).map((e) =>
        Array.isArray(e.spectrum) ? (e.spectrum as unknown[]).map((v) => Number(v)) : [],
      ),
    [epochs.data],
  );
  const times = useMemo(() => rows.map((r) => r.t), [rows]);

  const summary = useMemo(() => {
    const vals = (key: "depth" | "coebis" | "sef95" | "sr" | "seizure") =>
      rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
    const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const cadence =
      rows.length > 1
        ? Math.max(0.1, (rows[rows.length - 1]!.t - rows[0]!.t) / (rows.length - 1))
        : 1;
    const sr = vals("sr");
    const depth = vals("depth");
    const deepSeconds = depth.filter((d) => d < 40).length * cadence;
    return {
      duration: rows.length ? rows[rows.length - 1]!.t : 0,
      meanDepth: mean(depth),
      meanCoebis: mean(vals("coebis")),
      minDepth: depth.length ? Math.min(...depth) : null,
      meanSef: mean(vals("sef95")),
      meanSr: mean(sr),
      maxSr: sr.length ? Math.max(...sr) : null,
      maxSeizure: vals("seizure").length ? Math.max(...vals("seizure")) : null,
      suppressedSeconds: rows.filter((r) => r.suppressed).length * cadence,
      deepSeconds,
      cadence,
    };
  }, [rows]);

  const markers = events.data ?? [];
  const criticalEvents = markers.filter((m) => m.severity === "critical").length;

  const s = session.data;
  const loading = session.isLoading || epochs.isLoading;

  function printReport() {
    window.print();
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="no-print border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
          <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
            End-of-case report
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" onClick={printReport}>
              <Printer className="size-4" /> Print / save PDF
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/sessions">
                <ArrowLeft className="size-4" /> Sessions
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="print-sheet mx-auto max-w-5xl px-3 py-6 sm:px-4">
        {loading ? <p className="text-sm text-muted-foreground">Loading case…</p> : null}

        {!loading && !s ? (
          <div className="panel px-4 py-8 text-center text-sm text-muted-foreground">
            This case could not be found.
          </div>
        ) : null}

        {s ? (
          <>
            <section className="print-block">
              <h1 className="text-xl font-semibold">
                Depth-of-anaesthesia monitoring report — {s.case_code}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Anonymised record · Muse 2 frontal EEG · generated{" "}
                {formatStampInZone(new Date(), zone)} · all times shown in {zoneAbbreviation} (
                {zoneOffsetLabel}), stored in UTC · decision support only, not a diagnostic device.
              </p>
              <TimeZoneControl className="mt-2 print:hidden" />

              <dl className="panel mt-4 grid grid-cols-2 gap-3 px-4 py-3 sm:grid-cols-4">
                <Field label="Case code" value={s.case_code ?? ""} />
                <Field
                  label="Context"
                  value={CONTEXT_LABELS[s.context ?? "other"] ?? String(s.context ?? "")}
                />
                <Field label="Location" value={s.location ?? ""} />
                <Field label="Device" value={s.device_name ?? "Muse 2"} />
                <Field
                  label="Age"
                  value={s.age_years ? `${s.age_years} y` : s.age_band ? `${s.age_band} y` : ""}
                />
                <Field label="Sex" value={s.sex && s.sex !== "unknown" ? s.sex : ""} />
                <Field
                  label="Started"
                  value={formatStampInZone(s.started_at ?? s.created_at, zone)}
                />
                <Field
                  label="Ended"
                  value={s.ended_at ? formatStampInZone(s.ended_at, zone) : "—"}
                />
                <Field
                  label="Case duration"
                  value={
                    s.ended_at
                      ? formatCaseDuration(s.started_at ?? s.created_at, s.ended_at)
                      : "In progress"
                  }
                />
              </dl>

              {s.admission_diagnosis ? (
                <p className="mt-3 text-sm">
                  <span className="text-muted-foreground">Admission details: </span>
                  {s.admission_diagnosis}
                </p>
              ) : null}
              {s.clinical_features?.length ? (
                <p className="mt-1 text-sm">
                  <span className="text-muted-foreground">Clinical features: </span>
                  {(s.clinical_features as string[]).join(", ")}
                </p>
              ) : null}
            </section>

            <section className="print-block mt-5">
              <h2 className="text-sm font-semibold">Case summary</h2>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Monitored time" value={formatClock(summary.duration)} />
                <Stat
                  label="Mean depth index"
                  value={summary.meanDepth == null ? "—" : summary.meanDepth.toFixed(0)}
                  {...(summary.minDepth == null
                    ? {}
                    : { sub: `lowest ${summary.minDepth.toFixed(0)}` })}
                />
                <Stat
                  label="Time depth < 40"
                  value={formatDuration(summary.deepSeconds)}
                  {...(summary.duration
                    ? {
                        sub: `${((summary.deepSeconds / summary.duration) * 100).toFixed(0)} % of case`,
                      }
                    : {})}
                />
                <Stat
                  label="Mean SEF95"
                  value={summary.meanSef == null ? "—" : `${summary.meanSef.toFixed(1)} Hz`}
                />
                <Stat
                  label="Mean COEBIS"
                  value={summary.meanCoebis == null ? "—" : summary.meanCoebis.toFixed(0)}
                  sub={describeCoebisModel(coebisModel)}
                />
                <Stat
                  label="Mean suppression ratio"
                  value={summary.meanSr == null ? "—" : `${summary.meanSr.toFixed(1)} %`}
                  {...(summary.maxSr == null ? {} : { sub: `peak ${summary.maxSr.toFixed(0)} %` })}
                />
                <Stat label="Suppression time" value={formatDuration(summary.suppressedSeconds)} />
                <Stat
                  label="Peak seizure score"
                  value={summary.maxSeizure == null ? "—" : summary.maxSeizure.toFixed(2)}
                />
                <Stat
                  label="Critical events"
                  value={String(criticalEvents)}
                  sub={`${markers.length} logged in total`}
                />
              </div>
            </section>

            <section className="print-block mt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">Whole-case density spectral array</h2>
                <DsaLegend />
              </div>
              <div className="panel mt-2 h-64 overflow-hidden px-1 py-1">
                {spectra.length ? (
                  <SessionDsa spectra={spectra} times={times} />
                ) : (
                  <p className="p-4 text-sm text-muted-foreground">No spectral data stored.</p>
                )}
              </div>
            </section>

            <section className="print-block mt-5">
              <h2 className="text-sm font-semibold">Depth index and SEF95</h2>
              <div className="panel mt-2 h-40 px-2 py-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 4, left: -18 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      tick={{ fontSize: 10 }}
                      stroke="var(--muted-foreground)"
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 10 }}
                      stroke="var(--muted-foreground)"
                    />
                    <ReferenceLine y={40} stroke="var(--chart-4)" strokeDasharray="4 4" />
                    <ReferenceLine y={60} stroke="var(--chart-4)" strokeDasharray="4 4" />
                    <Line
                      type="monotone"
                      dataKey="depth"
                      stroke="var(--chart-1)"
                      dot={false}
                      strokeWidth={1.6}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="coebis"
                      stroke="var(--chart-3)"
                      dot={false}
                      strokeWidth={1.6}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="sef95"
                      stroke="var(--chart-2)"
                      dot={false}
                      strokeWidth={1.2}
                      isAnimationActive={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Depth index (0–100) with the 40–60 surgical band marked, COEBIS back-calculated
                from the same recording with the current model, and SEF95 in Hz on the same axis.
              </p>
            </section>

            <section className="print-block mt-5">
              <h2 className="text-sm font-semibold">Suppression ratio and seizure score</h2>
              <div className="panel mt-2 h-40 px-2 py-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 4, left: -18 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      tick={{ fontSize: 10 }}
                      stroke="var(--muted-foreground)"
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 10 }}
                      stroke="var(--muted-foreground)"
                    />
                    <Line
                      type="monotone"
                      dataKey="sr"
                      stroke="var(--chart-3)"
                      dot={false}
                      strokeWidth={1.6}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="seizure"
                      stroke="var(--destructive)"
                      dot={false}
                      strokeWidth={1.2}
                      isAnimationActive={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Suppression ratio in percent; seizure score plotted on the same axis (0–1 scale, low
                values expected).
              </p>
            </section>

            <section className="print-block print-page-break mt-5">
              <h2 className="text-sm font-semibold">Event and annotation log</h2>
              {markers.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No events logged for this case.
                </p>
              ) : (
                <div className="mt-2 -mx-1 overflow-x-auto px-1">
                <table className="w-full min-w-[420px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
                      <th className="py-1.5 pr-2">Time</th>
                      <th className="py-1.5 pr-2">Kind</th>
                      <th className="py-1.5 pr-2">Severity</th>
                      <th className="py-1.5 pr-2">Duration</th>
                      <th className="py-1.5">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {markers.map((m, i) => (
                      <tr key={`${m.t_offset_seconds}-${i}`} className="border-b border-border/60">
                        <td className="metric-value py-1.5 pr-2 whitespace-nowrap">
                          {formatClock(Number(m.t_offset_seconds) || 0)}
                        </td>
                        <td className="py-1.5 pr-2">{m.kind.replace(/_/g, " ")}</td>
                        <td className="py-1.5 pr-2">
                          {SEVERITY_LABEL[m.severity ?? "info"] ?? m.severity}
                        </td>
                        <td className="metric-value py-1.5 pr-2 whitespace-nowrap">
                          {Number(m.duration_seconds ?? 0) > 0
                            ? formatDuration(Number(m.duration_seconds))
                            : "—"}
                        </td>
                        <td className="py-1.5">{m.detail ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </section>

            {s.notes ? (
              <section className="print-block mt-5">
                <h2 className="text-sm font-semibold">Case notes</h2>
                <p className="mt-1 text-sm whitespace-pre-wrap">{s.notes}</p>
              </section>
            ) : null}

            <section className="print-block mt-5">
              <h2 className="text-sm font-semibold">Handover</h2>
              <div className="mt-2 grid gap-6 sm:grid-cols-2">
                <div className="border-b border-border pt-8 text-xs text-muted-foreground">
                  Clinician (name and grade)
                </div>
                <div className="border-b border-border pt-8 text-xs text-muted-foreground">
                  Signature / date
                </div>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                CortexTrace processes frontal EEG from a consumer Muse 2 headband. Indices are
                research-grade decision support and must be interpreted alongside clinical
                assessment and standard monitoring.
              </p>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
