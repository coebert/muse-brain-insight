import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, FileText } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { CoebisArcPanel } from "@/components/sessions/CoebisArcPanel";
import { listSessionObservations } from "@/lib/eeg/case-observations.functions";
import { SessionDsa } from "@/components/monitor/SessionDsa";
import { DsaLegend } from "@/components/monitor/DsaChart";
import { RawChannelViewer } from "@/components/monitor/RawChannelViewer";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { EPOCH_COLUMNS, EVENT_COLUMNS } from "@/lib/eeg/db-rows";
import { unseal } from "@/lib/privacy";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { loadSessionRawTraces } from "@/lib/eeg/raw-trace-store";
import type { DetectedEvent } from "@/lib/eeg/analysis";
import { formatStampInZone, useTimeZonePreference } from "@/lib/eeg/timezone";

export const Route = createFileRoute("/_authenticated/recording/$id")({
  head: () => ({
    meta: [
      { title: "Reopen recording — CortexTrace" },
      {
        name: "description",
        content:
          "Reopen a filed anaesthesia case and review its density spectral array and per-electrode raw EEG traces exactly as they were recorded.",
      },
      { property: "og:title", content: "Reopen recording — CortexTrace" },
      {
        property: "og:description",
        content:
          "Scroll back through the DSA and the raw EEG traces of a saved depth-of-anaesthesia case.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RecordingReview,
});

function RecordingReview() {
  const { id } = Route.useParams();
  const { zone } = useTimeZonePreference();

  const session = useQuery({
    queryKey: ["eeg_sessions", "recording", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("eeg_sessions").select("*").eq("id", id).single();
      if (error) throw error;
      const rows = await unseal([data], ["case_code", "location", "notes"]);
      return rows[0];
    },
  });

  const epochs = useQuery({
    queryKey: ["eeg_epochs", "recording", id],
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
    queryKey: ["eeg_events", "recording", id],
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

  const traces = useQuery({
    queryKey: ["session_raw_chunks", id],
    queryFn: () => loadSessionRawTraces(id),
    staleTime: Infinity,
  });

  const spectra = useMemo(
    () =>
      (epochs.data ?? []).map((e) =>
        Array.isArray(e.spectrum) ? (e.spectrum as unknown[]).map((v) => Number(v)) : [],
      ),
    [epochs.data],
  );
  const times = useMemo(
    () => (epochs.data ?? []).map((e) => Number(e.t_offset_seconds) || 0),
    [epochs.data],
  );

  const fetchObservations = useServerFn(listSessionObservations);
  const observations = useQuery({
    queryKey: ["case_observations", "session", id],
    queryFn: () => fetchObservations({ data: { sessionId: id } }),
    staleTime: 60_000,
  });

  const arcSamples = useMemo(
    () =>
      (epochs.data ?? []).map((e) => ({
        t: Number(e.t_offset_seconds) || 0,
        index: e.depth_index == null ? null : Number(e.depth_index),
        suppression: e.suppression_ratio == null ? null : Number(e.suppression_ratio),
        sef: e.spectral_edge_95 == null ? null : Number(e.spectral_edge_95),
      })),
    [epochs.data],
  );

  const detected: DetectedEvent[] = useMemo(
    () =>
      (events.data ?? []).map((e) => ({
        kind: e.kind as DetectedEvent["kind"],
        severity: (e.severity ?? "info") as DetectedEvent["severity"],
        t: Number(e.t_offset_seconds) || 0,
        duration: Number(e.duration_seconds) || 0,
        detail: e.detail ?? "",
      })),
    [events.data],
  );

  const s = session.data;
  const loading = session.isLoading || epochs.isLoading || traces.isLoading;
  const channels = traces.data?.channels ?? [];
  const contactOk = useMemo(
    () => Object.fromEntries(channels.map((c) => [c, true])),
    [channels.join("|")],
  );

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
          <AppNav />
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-3 py-6 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/sessions">
              <ArrowLeft className="size-4" /> Saved sessions
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="ml-auto">
            <Link to="/report/$id" params={{ id }}>
              <FileText className="size-4" /> End-of-case report
            </Link>
          </Button>
        </div>

        {loading ? <p className="text-sm text-muted-foreground">Opening recording…</p> : null}
        {!loading && !s ? (
          <div className="panel px-4 py-8 text-center text-sm text-muted-foreground">
            This case could not be found.
          </div>
        ) : null}

        {s ? (
          <>
            <section>
              <h1 className="text-lg font-semibold">Recording — {s.case_code}</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatStampInZone(s.started_at ?? s.created_at, zone)} ·{" "}
                {formatDuration(Number(s.duration_seconds ?? 0))} monitored ·{" "}
                {s.device_name ?? "Headband"}
              </p>
            </section>

            <section className="panel px-3 py-3 sm:px-4">
              <h2 className="text-sm font-semibold">Whole-case DSA</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Power by frequency across the whole case, as it was recorded.
              </p>
              <div className="mt-3 h-64">
                {spectra.length ? (
                  <SessionDsa spectra={spectra} times={times} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No spectral data was stored for this case.
                  </p>
                )}
              </div>
              <DsaLegend />
            </section>

            {traces.data ? (
              <RawChannelViewer
                archive={traces.data.archive}
                streaming={false}
                contactOk={contactOk}
                channelQuality={{}}
                events={detected}
              />
            ) : (
              <section className="panel px-4 py-6 text-sm text-muted-foreground">
                No raw EEG traces were stored with this case. Traces are kept for cases recorded
                from now on; earlier cases keep their DSA, numbers and notes only.
              </section>
            )}

            {traces.data ? (
              <p className="text-xs text-muted-foreground">
                {traces.data.channels.length} electrode
                {traces.data.channels.length === 1 ? "" : "s"} ·{" "}
                {formatClock(Math.round(traces.data.span))} of signal at {traces.data.sampleRate} Hz.
              </p>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
