import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, ArrowLeft } from "lucide-react";

import { DsaLegend } from "@/components/monitor/DsaChart";
import { SessionDsa } from "@/components/monitor/SessionDsa";
import { AiInsightPanel } from "@/components/monitor/AiInsightPanel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { unseal } from "@/lib/privacy";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { buildStoredDigest } from "@/lib/eeg/stored-digest";
import { interpretSession, type Interpretation } from "@/lib/eeg/interpret.functions";

export const Route = createFileRoute("/_authenticated/trends")({
  head: () => ({
    meta: [
      { title: "Session trends — whole-case DSA and metrics — CortexTrace" },
      {
        name: "description",
        content:
          "Review a complete monitoring session on one screen: full density spectral array plus suppression ratio, SEF95, depth index, entropy and seizure score trends with event markers.",
      },
      { property: "og:title", content: "Session trends — CortexTrace" },
      {
        property: "og:description",
        content:
          "Whole-session DSA with suppression ratio, SEF95, depth index and seizure trends on a single screen.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Trends,
});

interface EpochRow {
  t_offset_seconds: number;
  depth_index: number | null;
  spectral_edge_95: number | null;
  suppression_ratio: number | null;
  seizure_score: number | null;
  is_suppressed: boolean | null;
  consciousness_index: number | null;
  nociception_index: number | null;
  entropy: unknown;
  spectrum: unknown;
}

interface EventRow {
  t_offset_seconds: number;
  kind: string;
  severity: string | null;
  detail: string | null;
}

const SEVERITY_COLOR: Record<string, string> = {
  info: "var(--chart-4)",
  warning: "var(--chart-4)",
  critical: "var(--destructive)",
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="panel px-3 py-2">
      <p className="text-[10px] tracking-[0.16em] text-muted-foreground uppercase">{label}</p>
      <p className="metric-value text-lg leading-tight">{value}</p>
      {sub ? <p className="truncate text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function TrendPanel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel px-3 py-3 sm:px-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      <div className="mt-2 h-44">{children}</div>
    </section>
  );
}

const tooltipStyle = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
};

function Trends() {
  const [sessionId, setSessionId] = useState<string>("");

  const sessions = useQuery({
    queryKey: ["eeg_sessions", "trends"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_sessions")
        .select(
          "id, case_code, context, created_at, duration_seconds, age_band, sex, mean_suppression_ratio, max_suppression_ratio, admission_diagnosis, clinical_features, notes",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return unseal(data, ["case_code", "admission_diagnosis", "notes"]);
    },
  });

  const selectedId = sessionId || sessions.data?.[0]?.id || "";
  const selected = sessions.data?.find((s) => s.id === selectedId);

  const epochs = useQuery({
    queryKey: ["eeg_epochs", "trends", selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_epochs")
        .select(
          "t_offset_seconds, depth_index, spectral_edge_95, suppression_ratio, seizure_score, is_suppressed, consciousness_index, nociception_index, entropy, spectrum",
        )
        .eq("session_id", selectedId)
        .order("t_offset_seconds", { ascending: true });
      if (error) throw error;
      return data as unknown as EpochRow[];
    },
  });

  const events = useQuery({
    queryKey: ["eeg_events", "trends", selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_events")
        .select("t_offset_seconds, kind, severity, detail")
        .eq("session_id", selectedId)
        .order("t_offset_seconds", { ascending: true });
      if (error) throw error;
      return data as unknown as EventRow[];
    },
  });

  const rows = useMemo(() => {
    return (epochs.data ?? []).map((e) => {
      const ent = (e.entropy ?? null) as { state?: number; response?: number } | null;
      return {
        t: Number(e.t_offset_seconds) || 0,
        depth: e.depth_index === null ? null : Number(e.depth_index),
        sef95: e.spectral_edge_95 === null ? null : Number(e.spectral_edge_95),
        sr: e.suppression_ratio === null ? null : Number(e.suppression_ratio),
        seizure: e.seizure_score === null ? null : Number(e.seizure_score),
        cIndex: e.consciousness_index === null ? null : Number(e.consciousness_index),
        nIndex: e.nociception_index === null ? null : Number(e.nociception_index),
        entropy: typeof ent?.state === "number" ? Number((ent.state * 100).toFixed(1)) : null,
        suppressed: e.is_suppressed ? 1 : 0,
      };
    });
  }, [epochs.data]);

  const spectra = useMemo(
    () =>
      (epochs.data ?? []).map((e) =>
        Array.isArray(e.spectrum) ? (e.spectrum as unknown[]).map((v) => Number(v)) : [],
      ),
    [epochs.data],
  );
  const times = useMemo(() => rows.map((r) => r.t), [rows]);

  const summary = useMemo(() => {
    const vals = (key: "depth" | "sef95" | "sr" | "seizure") =>
      rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
    const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const cadence =
      rows.length > 1 ? Math.max(0.1, (rows[rows.length - 1]!.t - rows[0]!.t) / (rows.length - 1)) : 1;
    const suppressedSeconds = rows.filter((r) => r.suppressed).length * cadence;
    const sr = vals("sr");
    return {
      duration: rows.length ? rows[rows.length - 1]!.t : 0,
      meanDepth: mean(vals("depth")),
      meanSef: mean(vals("sef95")),
      meanSr: mean(sr),
      maxSr: sr.length ? Math.max(...sr) : null,
      maxSeizure: vals("seizure").length ? Math.max(...vals("seizure")) : null,
      suppressedSeconds,
    };
  }, [rows]);

  const markers = events.data ?? [];

  const [aiResult, setAiResult] = useState<Interpretation | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const runInterpretation = useServerFn(interpretSession);

  async function reviewCase() {
    if (!selected || rows.length === 0) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const digest = buildStoredDigest(
        rows,
        markers.map((m) => ({
          t: Number(m.t_offset_seconds) || 0,
          kind: m.kind,
          severity: m.severity ?? "info",
          detail: m.detail ?? m.kind,
        })),
        {
          caseCode: selected.case_code ?? "",
          context: selected.context ?? "general_anaesthesia",
          ageBand: selected.age_band ?? null,
          sex: selected.sex ?? null,
          admissionDiagnosis: selected.admission_diagnosis ?? null,
          clinicalFeatures: (selected.clinical_features as string[] | null) ?? [],
          notes: selected.notes ?? null,
          durationSeconds: summary.duration,
        },
      );
      setAiResult(await runInterpretation({ data: { digest } }));
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "AI analysis failed.");
    } finally {
      setAiLoading(false);
    }
  }

  const eventLines = (domainMax: number) =>
    markers.map((m, i) => (
      <ReferenceLine
        key={`${m.t_offset_seconds}-${i}`}
        x={Number(m.t_offset_seconds)}
        stroke={SEVERITY_COLOR[m.severity ?? "info"] ?? "var(--chart-4)"}
        strokeDasharray="3 3"
        strokeOpacity={0.8}
        ifOverflow="extendDomain"
        y1={0}
        y2={domainMax}
      />
    ));

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
          <Activity className="size-5 shrink-0 text-signal" />
          <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
            CortexTrace
          </span>
          <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
            <Button asChild variant="outline" size="sm">
              <Link to="/compare">Compare</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/sessions">Sessions</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/">
                <ArrowLeft className="size-4" /> Monitor
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-3 py-6 sm:px-4">
        <h1 className="text-lg font-semibold">Session trends</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The whole recording on one screen: full-session DSA plus suppression, SEF95, depth,
          entropy and seizure trends on a shared time axis, with event markers.
        </p>

        <div className="panel mt-4 flex flex-wrap items-end gap-4 px-3 py-3 sm:px-4">
          <div className="w-full min-w-0 sm:w-auto sm:min-w-72">
            <label className="text-[11px] tracking-wide text-muted-foreground uppercase">
              Patient / case
            </label>
            <Select value={selectedId} onValueChange={setSessionId}>
              <SelectTrigger className="mt-1 w-full">
                <SelectValue placeholder="Select a saved case" />
              </SelectTrigger>
              <SelectContent>
                {sessions.data?.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.case_code} · {new Date(s.created_at).toLocaleDateString()} ·{" "}
                    {formatClock(s.duration_seconds ?? 0)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DsaLegend />
        </div>

        {!sessions.isLoading && !sessions.data?.length ? (
          <div className="panel mt-6 px-4 py-8 text-center text-sm text-muted-foreground">
            No saved cases yet. Record and save a session on the monitor first.
          </div>
        ) : null}

        {epochs.isLoading ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading session…</p>
        ) : null}

        {!epochs.isLoading && selectedId && rows.length === 0 ? (
          <div className="panel mt-6 px-4 py-8 text-center text-sm text-muted-foreground">
            This case has no stored epoch data.
          </div>
        ) : null}

        {rows.length > 0 ? (
          <>
            {selected ? (
              <p className="metric-value mt-3 text-xs text-muted-foreground">
                {selected.case_code} · {selected.context}
                {selected.age_band ? ` · ${selected.age_band} y` : ""}
                {selected.sex && selected.sex !== "unknown" ? ` · ${selected.sex}` : ""} ·{" "}
                {rows.length} epochs
              </p>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Duration" value={formatClock(summary.duration)} />
              <Stat
                label="Mean depth"
                value={summary.meanDepth == null ? "—" : summary.meanDepth.toFixed(0)}
              />
              <Stat
                label="Mean SEF95"
                value={summary.meanSef == null ? "—" : `${summary.meanSef.toFixed(1)} Hz`}
              />
              <Stat
                label="Mean SR"
                value={summary.meanSr == null ? "—" : `${summary.meanSr.toFixed(1)} %`}
                sub={summary.maxSr == null ? undefined : `peak ${summary.maxSr.toFixed(0)} %`}
              />
              <Stat label="Suppressed time" value={formatDuration(summary.suppressedSeconds)} />
              <Stat
                label="Peak seizure score"
                value={summary.maxSeizure == null ? "—" : summary.maxSeizure.toFixed(2)}
              />
            </div>

            <div className="mt-4">
              <AiInsightPanel
                result={aiResult}
                loading={aiLoading}
                error={aiError}
                epochCount={rows.length}
                onRun={() => void reviewCase()}
                runLabel="Review this case"
                sessionId={selected?.id ?? null}
                feedbackContext={selected?.context ?? null}
              />
            </div>

            <section className="panel mt-4 px-3 py-3 sm:px-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">Whole-session density spectral array</h2>
                <span className="text-[11px] text-muted-foreground">
                  {spectra.length} epochs compressed to screen width
                </span>
              </div>
              <div className="mt-2 h-64 sm:h-80">
                <SessionDsa spectra={spectra} times={times} />
              </div>
            </section>

            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <TrendPanel title="Suppression ratio (%)" hint="burst-suppression burden">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis domain={[0, 100]} stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v) => `t ${formatClock(Number(v))}`}
                    />
                    <ReferenceLine y={40} stroke="var(--destructive)" strokeDasharray="4 4" />
                    {eventLines(100)}
                    <Area
                      type="monotone"
                      dataKey="sr"
                      stroke="var(--chart-3)"
                      fill="var(--chart-3)"
                      fillOpacity={0.22}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </TrendPanel>

              <TrendPanel title="SEF95 (Hz)" hint="spectral edge frequency">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis domain={[0, 30]} stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v) => `t ${formatClock(Number(v))}`}
                    />
                    {eventLines(30)}
                    <Line
                      type="monotone"
                      dataKey="sef95"
                      stroke="var(--chart-2)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </TrendPanel>

              <TrendPanel title="Depth index" hint="target band 40–60">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis domain={[0, 100]} stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v) => `t ${formatClock(Number(v))}`}
                    />
                    <ReferenceLine y={40} stroke="var(--chart-4)" strokeDasharray="4 4" />
                    <ReferenceLine y={60} stroke="var(--chart-4)" strokeDasharray="4 4" />
                    {eventLines(100)}
                    <Line
                      type="monotone"
                      dataKey="depth"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="cIndex"
                      stroke="var(--chart-5)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="nIndex"
                      stroke="var(--chart-4)"
                      strokeWidth={1.5}
                      strokeDasharray="2 3"
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </TrendPanel>

              <TrendPanel title="Entropy ×100 and seizure score" hint="seizure score on 0–1 scale ×100">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis domain={[0, 100]} stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v) => `t ${formatClock(Number(v))}`}
                    />
                    {eventLines(100)}
                    <Line
                      type="monotone"
                      dataKey="entropy"
                      stroke="var(--chart-5)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey={(r: (typeof rows)[number]) =>
                        r.seizure == null ? null : r.seizure * 100
                      }
                      name="seizure"
                      stroke="var(--destructive)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </TrendPanel>
            </div>

            <section className="panel mt-4 px-3 py-3 sm:px-4">
              <h2 className="text-sm font-semibold">Events ({markers.length})</h2>
              {markers.length ? (
                <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {markers.map((m, i) => (
                    <li
                      key={`${m.t_offset_seconds}-${i}`}
                      className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
                    >
                      <span className="metric-value text-muted-foreground">
                        {formatClock(Number(m.t_offset_seconds))}
                      </span>
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: SEVERITY_COLOR[m.severity ?? "info"] }}
                      />
                      <span className="truncate">{m.detail || m.kind}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  No markers or detected events stored for this case.
                </p>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
