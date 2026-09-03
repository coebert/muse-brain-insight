import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Globe, Loader2, ScanSearch } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  checkEligibility,
  CREDENTIAL_REALMS,
  INTAKE_SOURCES,
  type IntakeRunResult,
} from "@/lib/eeg/dataset-intake";
import {
  getIntakeCredentials,
  getIntakeHistory,
  runIntake,
} from "@/lib/eeg/dataset-intake.functions";

/**
 * Automated intake of public EEG collections. The scan reads each configured
 * source's published index, fetches only files whose licence permits
 * programmatic retrieval, runs them through the same parsing and harmonisation
 * path as the manual panels, and records licence and provenance per lineage.
 * Credentialed collections stay visible but are never downloaded.
 */
export function DatasetIntakePanel() {
  const [result, setResult] = useState<IntakeRunResult | null>(null);
  const runScan = useServerFn(runIntake);
  const loadHistory = useServerFn(getIntakeHistory);
  const loadCredentials = useServerFn(getIntakeCredentials);
  const queryClient = useQueryClient();

  const history = useQuery({
    queryKey: ["dataset-intake-history"],
    queryFn: () => loadHistory({}),
  });

  const credentials = useQuery({
    queryKey: ["dataset-intake-credentials"],
    queryFn: () => loadCredentials({}),
  });
  const realms = credentials.data?.realms ?? [];

  const scan = useMutation({
    mutationFn: (dryRun: boolean) => runScan({ data: { dryRun } }),
    onSuccess: (run) => {
      setResult(run);
      const ingested = run.sources.reduce((a, s) => a + s.ingested, 0);
      const epochs = run.sources.reduce((a, s) => a + s.epochsInserted, 0);
      toast.success(
        run.dryRun
          ? `Scan complete — ${run.sources.reduce((a, s) => a + s.files.length, 0)} eligible files found.`
          : `Intake complete — ${ingested} files, ${epochs} new epochs.`,
      );
      if (!run.dryRun) {
        void queryClient.invalidateQueries({ queryKey: ["dataset-intake-history"] });
        void queryClient.invalidateQueries({ queryKey: ["physionet-pool"] });
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Intake failed."),
  });

  const busy = scan.isPending;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-primary" aria-hidden />
          <h3 className="text-sm font-semibold">Automated public-dataset intake</h3>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => scan.mutate(true)}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
            Scan only
          </Button>
          <Button size="sm" disabled={busy} onClick={() => scan.mutate(false)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Run intake
          </Button>
        </div>
      </header>

      <p className="mb-3 text-xs text-muted-foreground">
        Restricted sources are fetched only when a matching login is stored:{" "}
        {(Object.keys(CREDENTIAL_REALMS) as (keyof typeof CREDENTIAL_REALMS)[]).map((realm) => (
          <span key={realm} className="mr-2">
            {CREDENTIAL_REALMS[realm].label}{" "}
            <strong>{realms.includes(realm) ? "configured" : "not configured"}</strong>
          </span>
        ))}
        — downloads then run as your own credentialed account under the agreement you signed.
      </p>

      <p className="mb-3 text-xs text-muted-foreground">
        Each source keeps its own lineage, so nothing fetched here is pooled into the
        device-specific COEBIS fit — it feeds tier-level priors and per-lineage
        benchmarking only. Licence, URL, byte size, content digest and harmonisation
        version are stored for every file.
      </p>

      <ul className="space-y-2">
        {INTAKE_SOURCES.map((s) => {
          const gate = checkEligibility(s, realms);
          const seen = history.data?.provenance.find((p) => p.sourceId === s.id);
          const ran = result?.sources.find((r) => r.sourceId === s.id);
          return (
            <li key={s.id} className="rounded border border-border/60 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{s.label}</span>
                <span
                  className={
                    gate.eligible
                      ? "rounded bg-primary/10 px-2 py-0.5 text-primary"
                      : "rounded bg-muted px-2 py-0.5 text-muted-foreground"
                  }
                >
                  {gate.eligible
                    ? s.credentialRealm && s.access === "credentialed"
                      ? "credentialed"
                      : "auto-eligible"
                    : s.access}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground">{gate.reason}</p>
              <p className="mt-1 text-muted-foreground">
                Lineage <code>{s.lineage}</code> ·{" "}
                <a
                  className="underline"
                  href={s.licenceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {s.licence}
                </a>
              </p>
              {seen ? (
                <p className="mt-1 text-muted-foreground">
                  Held: {seen.files} files, {seen.epochs} epochs
                  {seen.datasetVersions.length ? ` · version ${seen.datasetVersions.join(", ")}` : ""}
                  {seen.harmonizationVersions.length
                    ? ` · harmonisation ${seen.harmonizationVersions.join(", ")}`
                    : ""}
                  {seen.lastFetchedAt
                    ? ` · fetched ${new Date(seen.lastFetchedAt).toLocaleString()}`
                    : ""}
                  {seen.latestDigest ? (
                    <>
                      {" · digest "}
                      <code>{seen.latestDigest.slice(0, 12)}…</code>
                    </>
                  ) : null}
                  {" · "}
                  <a className="underline" href={s.homepage} target="_blank" rel="noreferrer noopener">
                    published record
                  </a>
                </p>
              ) : null}
              {s.accessNote && gate.eligible ? (
                <p className="mt-1 text-muted-foreground">Terms: {s.accessNote}</p>
              ) : null}
              {ran ? (
                <p className="mt-1">
                  Last run: {ran.discovered} listed, {ran.attempted} attempted, {ran.ingested}{" "}
                  ingested, {ran.epochsInserted} new epochs
                  {ran.files.length ? (
                    <span className="block text-muted-foreground">
                      {ran.files
                        .slice(0, 4)
                        .map((f) => `${f.file}: ${f.status}${f.detail ? ` — ${f.detail}` : ""}`)
                        .join(" · ")}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {history.data?.runs.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Last run {new Date(history.data.runs[0]!.startedAt).toLocaleString()} —{" "}
          {history.data.runs[0]!.filesIngested} files, {history.data.runs[0]!.epochsInserted}{" "}
          epochs across {history.data.runs[0]!.sourcesScanned} sources.
        </p>
      ) : null}
    </section>
  );
}
