import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Waves } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { BleHeadsetPanel } from "@/components/monitor/BleHeadsetPanel";
import { ConnectionStatusBadge } from "@/components/monitor/ConnectionStatusBadge";
import { LiveSpectrumPanel } from "@/components/monitor/LiveSpectrumPanel";
import { LiveWaveform } from "@/components/monitor/LiveWaveform";
import { useCaseSession } from "@/components/monitor/CaseSessionProvider";
import { Button } from "@/components/ui/button";
import { deriveConnectionStatus } from "@/lib/eeg/connection-status";
import { formatClock } from "@/lib/eeg/format";

export const Route = createFileRoute("/_authenticated/brainwaves")({
  head: () => ({
    meta: [
      { title: "Live brainwaves — CortexTrace EEG headband stream" },
      {
        name: "description",
        content:
          "Watch decoded EEG from a paired FocusCalm/Regul8 or Muse 2 headband in real time: raw trace, power spectrum and band powers.",
      },
      { property: "og:title", content: "Live brainwaves — CortexTrace" },
      {
        property: "og:description",
        content: "Real-time raw EEG trace, spectrum and band powers from a paired headband.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BrainwavesPage,
});

const BANDS = [
  { key: "delta", label: "Delta", range: "0.5–4 Hz" },
  { key: "theta", label: "Theta", range: "4–8 Hz" },
  { key: "alpha", label: "Alpha", range: "8–13 Hz" },
  { key: "beta", label: "Beta", range: "13–30 Hz" },
  { key: "gamma", label: "Gamma", range: "30–45 Hz" },
] as const;

function BrainwavesPage() {
  const session = useCaseSession();
  const { monitor, latest, streaming, caseRunning, testing, caseState, startCase, endTesting } =
    session;

  const connection = deriveConnectionStatus({
    status: monitor.status,
    sourceName: monitor.sourceName,
    caseEnded: caseState === "ended",
    dataGapSeconds: monitor.dataGapSeconds,
    reconnectAttempt: monitor.reconnectAttempt,
  });

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:px-6">
        <AppNav />
      </header>

      <main className="mx-auto w-full max-w-5xl space-y-4 p-3 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/">
                <ArrowLeft className="size-4" /> Monitor
              </Link>
            </Button>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <Waves className="size-5 text-signal" aria-hidden /> Live brainwaves
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionStatusBadge status={connection} />
            {streaming ? (
              <span className="metric-value text-xs text-muted-foreground">
                {formatClock(monitor.elapsed)}
              </span>
            ) : null}
          </div>
        </div>

        {!caseRunning ? (
          <section className="space-y-3 rounded-lg border border-border p-3 sm:p-4">
            <p className="text-sm text-muted-foreground">
              Pair the headband here to watch its EEG live. This is a throwaway view — nothing is
              filed to your records. Start a case from the Monitor page when you want to record.
            </p>
            <BleHeadsetPanel
              onStart={(source, onConnectionError) =>
                startCase("ingest", { source, onConnectionError, asTest: true })
              }
            />
            <MacBridgePanel
              onStart={(source, onConnectionError) =>
                startCase("ingest", { source, onConnectionError, asTest: true })
              }
            />
          </section>
        ) : (
          <>
            {testing ? (
              <p className="rounded-md border border-caution/50 bg-caution/10 px-3 py-2 text-xs text-caution">
                Testing mode — this stream is shown live but never saved.
              </p>
            ) : null}

            <section className="rounded-lg border border-border p-3 sm:p-4">
              <h2 className="mb-2 text-sm font-medium">Raw trace</h2>
              <div className="h-[180px]">
                <LiveWaveform
                  store={monitor.waveformStore}
                  suppressionThresholdUv={monitor.settings.suppressionThresholdUv}
                  suppressed={latest?.isSuppressed ?? false}
                />
              </div>
            </section>

            <LiveSpectrumPanel latest={latest} epochs={monitor.epochs} />

            <section className="rounded-lg border border-border p-3 sm:p-4">
              <h2 className="mb-3 text-sm font-medium">Band powers</h2>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {BANDS.map((b) => (
                  <div key={b.key} className="rounded-md border border-border/60 p-2">
                    <dt className="text-xs text-muted-foreground">
                      {b.label} <span className="opacity-70">{b.range}</span>
                    </dt>
                    <dd className="metric-value text-lg">
                      {latest ? latest.bands[b.key].toFixed(1) : "—"}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="SEF95" value={latest ? `${latest.sef95.toFixed(1)} Hz` : "—"} />
                <Metric
                  label="Amplitude"
                  value={latest ? `${latest.amplitudeUv.toFixed(1)} µV` : "—"}
                />
                <Metric
                  label="Suppression ratio"
                  value={latest ? `${latest.suppressionRatio.toFixed(0)} %` : "—"}
                />
                <Metric
                  label="Signal quality"
                  value={latest ? latest.quality.grade : "—"}
                />
              </div>
            </section>

            {testing ? (
              <Button variant="outline" onClick={() => endTesting()}>
                End test stream
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                A case is recording — end it from the Monitor page.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="metric-value text-lg">{value}</div>
    </div>
  );
}
