import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  mapOpenNeuroBisFile,
  normaliseDatasetId,
  parseBidsPhysioJson,
  parseMonitorTable,
  parseParticipantsTsv,
  parsePhysioTable,
  subjectOf,
  type BidsPhysioMeta,
  type OpenNeuroParticipant,
} from "@/lib/eeg/openneuro-bis";
import {
  getOpenNeuroBisLineages,
  importOpenNeuroBis,
} from "@/lib/eeg/openneuro-bis.functions";
import type { OpenNeuroBisCasePayload } from "@/lib/eeg/openneuro-bis.server";

/** Read a file as text, transparently gunzipping BIDS `.gz` tables. */
async function readText(file: File): Promise<string> {
  if (!file.name.endsWith(".gz")) return file.text();
  const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Match a physio table to its sidecar by stripping the extension. */
function stemOf(name: string): string {
  return name.replace(/\.tsv(\.gz)?$/i, "").replace(/\.json$/i, "").replace(/\.csv$/i, "");
}

/**
 * OpenNeuro records that publish bedside depth-monitor numerics alongside their
 * EEG get their own lineage here. The readings are commercial monitor output,
 * so they are held as external reference data — population expectation per age,
 * sex and regimen — and never enter the app-to-BIS alignment.
 */
export function OpenNeuroBisImportPanel() {
  const [datasetId, setDatasetId] = useState("ds004541");
  const [participants, setParticipants] = useState<Map<string, OpenNeuroParticipant> | null>(null);
  const [participantsName, setParticipantsName] = useState<string | null>(null);
  const participantsRef = useRef<HTMLInputElement>(null);
  const bisRef = useRef<HTMLInputElement>(null);

  const runImport = useServerFn(importOpenNeuroBis);
  const runLineages = useServerFn(getOpenNeuroBisLineages);

  const lineages = useQuery({
    queryKey: ["openneuro-bis-lineages"],
    queryFn: () => runLineages({}),
  });

  const importMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const id = normaliseDatasetId(datasetId);
      if (!id) throw new Error("Enter the OpenNeuro accession first, e.g. ds004541.");

      // Sidecars first: a BIDS physio table is headerless and unreadable alone.
      const sidecars = new Map<string, BidsPhysioMeta>();
      for (const f of files.filter((f) => f.name.endsWith(".json"))) {
        const meta = parseBidsPhysioJson(await readText(f));
        if (meta) sidecars.set(stemOf(f.name), meta);
      }

      const cases: OpenNeuroBisCasePayload[] = [];
      let unreadable = 0;
      for (const file of files) {
        if (file.name.endsWith(".json")) continue;
        const text = await readText(file);
        const meta = sidecars.get(stemOf(file.name));
        const samples = meta ? parsePhysioTable(text, meta) : parseMonitorTable(text);
        if (!samples.length) {
          unreadable++;
          continue;
        }
        const subject = subjectOf(file.name);
        const mapped = mapOpenNeuroBisFile(
          id,
          file.name,
          samples,
          (subject && participants?.get(subject)) || null,
          { strideSeconds: 10, minSqi: 50 },
        );
        if (mapped.points.length) {
          cases.push({
            caseRef: mapped.caseRef,
            lineage: mapped.lineage,
            covariates: mapped.covariates,
            points: mapped.points,
          });
        } else {
          unreadable++;
        }
      }
      if (!cases.length) {
        throw new Error(
          "No usable BIS readings found. A BIDS physio table needs its .json sidecar selected too.",
        );
      }
      const result = await runImport({ data: { cases } });
      return { ...result, unreadable };
    },
    onSuccess: (result) => {
      toast.success(
        `Imported ${result.inserted} readings from ${result.cases} cases into ${
          result.lineages.join(", ") || "no new lineage"
        }`,
        {
          description: [
            result.skipped ? `${result.skipped} were already present.` : null,
            result.unreadable ? `${result.unreadable} files had no readable BIS column.` : null,
          ]
            .filter(Boolean)
            .join(" "),
        },
      );
      void lineages.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Import failed."),
  });

  return (
    <section className="panel p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Activity className="size-4 text-signal" /> Import OpenNeuro BIS readings
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Some OpenNeuro anaesthesia records publish the bedside depth monitor next to the EEG, either
        as a BIDS physio recording (
        <code className="rounded bg-muted px-1">*_recording-bis_physio.tsv.gz</code> with its{" "}
        <code className="rounded bg-muted px-1">.json</code> sidecar) or as a plain table with time
        and BIS columns. Each accession is filed under its own lineage (
        <code className="rounded bg-muted px-1">external:openneuro:&#123;id&#125;</code>) so its
        contribution stays separable on the model performance page. These are commercial monitor
        readings with no app-side index, so they inform the population prior only and never the
        app-to-BIS alignment. Load{" "}
        <code className="rounded bg-muted px-1">participants.tsv</code> first to attach age, sex and
        agent covariates.
      </p>

      <input
        ref={participantsRef}
        type="file"
        accept=".tsv,.csv,text/tab-separated-values,text/csv"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const parsed = parseParticipantsTsv(await readText(file));
          if (!parsed.size) {
            toast.error("No participant_id column — is that the BIDS participants.tsv?");
            return;
          }
          setParticipants(parsed);
          setParticipantsName(`${file.name} · ${parsed.size} participants`);
        }}
      />
      <input
        ref={bisRef}
        type="file"
        accept=".tsv,.csv,.gz,.json"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) importMutation.mutate(files);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={datasetId}
          onChange={(e) => setDatasetId(e.target.value)}
          placeholder="ds004541"
          aria-label="OpenNeuro dataset accession"
          className="h-11 w-36 sm:h-9"
        />
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          onClick={() => participantsRef.current?.click()}
        >
          1. participants.tsv
        </Button>
        <Button
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => bisRef.current?.click()}
          disabled={importMutation.isPending || !datasetId.trim()}
        >
          {importMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          2. BIS files (+ sidecars)
        </Button>
        {participantsName ? (
          <span className="text-xs text-muted-foreground">{participantsName}</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            Optional — without it, readings import with no covariates.
          </span>
        )}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        {lineages.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">Lineage</th>
                  <th className="py-1 text-right font-medium">Cases</th>
                  <th className="py-1 text-right font-medium">Readings</th>
                  <th className="py-1 text-right font-medium">Mean BIS</th>
                </tr>
              </thead>
              <tbody>
                {lineages.data.map((row) => (
                  <tr key={row.lineage} className="border-t border-border/60">
                    <td className="py-1 font-mono">{row.lineage}</td>
                    <td className="py-1 text-right tabular-nums">{row.cases}</td>
                    <td className="py-1 text-right tabular-nums">{row.readings}</td>
                    <td className="py-1 text-right tabular-nums">{row.meanBis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No OpenNeuro BIS readings imported yet.
          </p>
        )}
      </div>
    </section>
  );
}
