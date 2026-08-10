import { useMemo, useState } from "react";
import { EPOCH_COLUMNS } from "@/lib/eeg/db-rows";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
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
import { formatClock } from "@/lib/eeg/format";
import { computeCoebis } from "@/lib/eeg/depth";
import { useCoebisModel } from "@/hooks/useCoebisModel";
import { correlate, correlationStrength, rollingCorrelation } from "@/lib/eeg/correlation";

export const Route = createFileRoute("/_authenticated/compare")({
  head: () => ({
    meta: [
      { title: "Depth index vs SEF95 comparison — CortexTrace" },
      {
        name: "description",
        content:
          "Overlay the OpenIBIS-style depth index against SEF95 and burst-suppression metrics for a saved case, with Pearson correlations and rolling agreement over time.",
      },
      { property: "og:title", content: "Depth index vs SEF95 comparison — CortexTrace" },
      {
        property: "og:description",
        content:
          "Per-patient comparison of depth index, spectral edge frequency and suppression ratio with correlation analysis.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Compare,
});

const SERIES = [
  { key: "depth", label: "Depth index (OpenIBIS)", color: "var(--chart-1)", axis: "left" },
  { key: "sef95", label: "SEF95 (Hz)", color: "var(--chart-2)", axis: "left" },
  { key: "sr", label: "Suppression ratio (%)", color: "var(--chart-3)", axis: "left" },
  { key: "entropy", label: "State entropy (x100)", color: "var(--chart-5)", axis: "left" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];

function Compare() {
  const [sessionId, setSessionId] = useState<string>("");
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    depth: true,
    sef95: true,
    sr: true,
    entropy: false,
  });
  const [windowMinutes, setWindowMinutes] = useState(5);

  const sessions = useQuery({
    queryKey: ["eeg_sessions", "compare"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_sessions")
        .select("id, case_code, context, created_at, duration_seconds, age_band, sex")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return unseal(data, ["case_code"]);
    },
  });

  const selectedId = sessionId || sessions.data?.[0]?.id || "";
  const selected = sessions.data?.find((s) => s.id === selectedId);

  const epochs = useQuery({
    queryKey: ["eeg_epochs", selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_epochs")
        .select(EPOCH_COLUMNS)
        .eq("session_id", selectedId)
        .order("t_offset_seconds", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const rows = useMemo(() => {
    const list = epochs.data ?? [];
    return list.map((e) => {
      const ent = (e.entropy ?? null) as { state?: number } | null;
      const depth = e.depth_index === null ? null : Number(e.depth_index);
      return {
        t: Number(e.t_offset_seconds) || 0,
        depth,
        // Back-calculated with the current COEBIS model, not stored per epoch.
        coebis: depth === null ? null : computeCoebis(depth),
        sef95: e.spectral_edge_95 === null ? null : Number(e.spectral_edge_95),
        sr: e.suppression_ratio === null ? null : Number(e.suppression_ratio),
        seizure: e.seizure_score === null ? null : Number(e.seizure_score),
        entropy: typeof ent?.state === "number" ? Number((ent.state * 100).toFixed(1)) : null,
      };
    });
  }, [epochs.data, coebisModel]);

  /** Epoch cadence in seconds, used to convert lag samples to time. */
  const cadence = useMemo(() => {
    if (rows.length < 2) return 1;
    const diffs = rows
      .slice(1)
      .map((r, i) => r.t - rows[i]!.t)
      .filter((d) => d > 0);
    diffs.sort((a, b) => a - b);
    return diffs.length ? diffs[Math.floor(diffs.length / 2)]! : 1;
  }, [rows]);

  function pairs(a: keyof (typeof rows)[number], b: keyof (typeof rows)[number]) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of rows) {
      const x = r[a];
      const y = r[b];
      if (typeof x === "number" && typeof y === "number") {
        xs.push(x);
        ys.push(y);
      }
    }
    return { xs, ys };
  }

  const comparisons = useMemo(() => {
    const defs: {
      label: string;
      a: "depth" | "coebis";
      b: "coebis" | "sef95" | "sr" | "seizure" | "entropy";
    }[] = [
      { label: "Depth index vs COEBIS", a: "depth", b: "coebis" },
      { label: "Depth index vs SEF95", a: "depth", b: "sef95" },
      { label: "COEBIS vs suppression ratio", a: "coebis", b: "sr" },
      { label: "Depth index vs suppression ratio", a: "depth", b: "sr" },
      { label: "Depth index vs state entropy", a: "depth", b: "entropy" },
      { label: "Depth index vs seizure score", a: "depth", b: "seizure" },
    ];
    return defs.map((d) => {
      const { xs, ys } = pairs(d.a, d.b);
      return { ...d, result: correlate(xs, ys, 12) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const rollingWindow = Math.max(5, Math.round((windowMinutes * 60) / Math.max(cadence, 0.1)));

  const rollingData = useMemo(() => {
    const idx: number[] = [];
    const depth: number[] = [];
    const sef: number[] = [];
    const sr: number[] = [];
    rows.forEach((r, i) => {
      if (typeof r.depth === "number" && typeof r.sef95 === "number" && typeof r.sr === "number") {
        idx.push(i);
        depth.push(r.depth);
        sef.push(r.sef95);
        sr.push(r.sr);
      }
    });
    const rSef = rollingCorrelation(depth, sef, rollingWindow);
    const rSr = rollingCorrelation(depth, sr, rollingWindow);
    return idx.map((i, k) => ({
      t: rows[i]!.t,
      rSef: rSef[k] ?? null,
      rSr: rSr[k] ?? null,
    }));
  }, [rows, rollingWindow]);

  const suppressionSpans = useMemo(() => rows.filter((r) => (r.sr ?? 0) >= 20), [rows]);

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
          <Activity className="size-5 shrink-0 text-signal" />
          <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
            CortexTrace
          </span>
          <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
            <Button asChild variant="outline" size="sm">
              <Link to="/validate">Agreement report</Link>
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

      <main className="mx-auto max-w-6xl px-3 py-6 sm:px-4">
        <h1 className="text-lg font-semibold">Metric comparison</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Overlay the depth index against SEF95, suppression and entropy for one anonymised case,
          then read how tightly they track each other over time.
        </p>

        <div className="panel mt-4 flex flex-wrap items-end gap-4 px-3 py-3 sm:px-4">
          <div className="w-full min-w-0 sm:w-auto sm:min-w-64">
            <label className="text-xs tracking-wide text-muted-foreground uppercase">
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

          <div>
            <span className="text-xs tracking-wide text-muted-foreground uppercase">Series</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {SERIES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setVisible((v) => ({ ...v, [s.key]: !v[s.key] }))}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    visible[s.key]
                      ? "border-border bg-accent text-accent-foreground"
                      : "border-border/60 text-muted-foreground"
                  }`}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ background: s.color, opacity: visible[s.key] ? 1 : 0.35 }}
                  />
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs tracking-wide text-muted-foreground uppercase">
              Rolling window: {windowMinutes} min
            </label>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={windowMinutes}
              onChange={(e) => setWindowMinutes(Number(e.target.value))}
              className="mt-2 block w-40 accent-signal"
            />
          </div>
        </div>

        {selected ? (
          <p className="metric-value mt-3 text-xs text-muted-foreground">
            {selected.case_code} · {selected.context}
            {selected.age_band ? ` · ${selected.age_band} y` : ""}
            {selected.sex && selected.sex !== "unknown" ? ` · ${selected.sex}` : ""} · {rows.length}{" "}
            stored epochs · {formatClock(selected.duration_seconds ?? 0)}
          </p>
        ) : null}

        {epochs.isLoading ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading epochs…</p>
        ) : null}

        {!epochs.isLoading && selectedId && rows.length === 0 ? (
          <div className="panel mt-6 px-4 py-8 text-center text-sm text-muted-foreground">
            This case has no stored epoch trend data.
          </div>
        ) : null}

        {!sessions.isLoading && !sessions.data?.length ? (
          <div className="panel mt-6 px-4 py-8 text-center text-sm text-muted-foreground">
            No saved cases yet. Record and save a session on the monitor first.
          </div>
        ) : null}

        {rows.length > 0 ? (
          <>
            <section className="panel mt-5 px-4 py-4">
              <h2 className="text-sm font-semibold">Overlay</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Depth index 0–100, SEF95 in Hz, suppression ratio in %, entropy scaled ×100 so all
                share one axis.
              </p>
              <div className="mt-3 h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: -12 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis domain={[0, 100]} stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--panel)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelFormatter={(v) => `t ${formatClock(Number(v))}`}
                    />
                    <ReferenceLine y={40} stroke="var(--chart-4)" strokeDasharray="4 4" />
                    <ReferenceLine y={60} stroke="var(--chart-4)" strokeDasharray="4 4" />
                    {SERIES.filter((s) => visible[s.key]).map((s) => (
                      <Line
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        name={s.label}
                        stroke={s.color}
                        strokeWidth={1.6}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Dashed lines mark the 40–60 depth-index band usually targeted for general
                anaesthesia. {suppressionSpans.length} epochs recorded a suppression ratio ≥ 20 %.
              </p>
            </section>

            <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {comparisons.map((c) => (
                <div key={c.label} className="panel px-4 py-3">
                  <p className="text-xs tracking-wide text-muted-foreground uppercase">{c.label}</p>
                  <p className="metric-value mt-1 text-2xl">
                    {c.result.r === null ? "—" : `r ${c.result.r.toFixed(2)}`}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {correlationStrength(c.result.r)}
                  </p>
                  <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <dt>Paired epochs</dt>
                      <dd className="metric-value">{c.result.n}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>p</dt>
                      <dd className="metric-value">
                        {c.result.p === null
                          ? "—"
                          : c.result.p < 0.001
                            ? "< 0.001"
                            : c.result.p.toFixed(3)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Best lag</dt>
                      <dd className="metric-value">
                        {c.result.bestLagR === null
                          ? "—"
                          : `${(c.result.bestLag * cadence).toFixed(0)} s (r ${c.result.bestLagR.toFixed(2)})`}
                      </dd>
                    </div>
                  </dl>
                </div>
              ))}
            </section>

            <section className="panel mt-5 px-4 py-4">
              <h2 className="text-sm font-semibold">Correlation over time</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Sliding {windowMinutes}-minute Pearson r. Divergence between the depth index and
                SEF95 usually means artefact, EMG or a burst-suppression transition.
              </p>
              <div className="mt-3 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rollingData} margin={{ top: 8, right: 8, bottom: 4, left: -12 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis domain={[-1, 1]} stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--panel)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(v: number | string) => (typeof v === "number" ? v.toFixed(2) : v)}
                      labelFormatter={(v) => `t ${formatClock(Number(v))}`}
                    />
                    <ReferenceLine y={0} stroke="var(--border)" />
                    <Line
                      type="monotone"
                      dataKey="rSef"
                      name="Depth vs SEF95"
                      stroke="var(--chart-2)"
                      strokeWidth={1.6}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="rSr"
                      name="Depth vs suppression"
                      stroke="var(--chart-3)"
                      strokeWidth={1.6}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: "var(--chart-2)" }} />
                  Depth vs SEF95
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: "var(--chart-3)" }} />
                  Depth vs suppression ratio
                </span>
              </div>
            </section>

            <p className="mt-4 text-xs text-muted-foreground">
              Research and decision-support only. The depth index is uncalibrated and derived from a
              frontal consumer montage; do not titrate anaesthesia on these values alone.
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
