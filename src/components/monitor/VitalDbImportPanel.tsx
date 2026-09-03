import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Database, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  mapVitalDbCase,
  parseVitalDbClinicalCsv,
  parseVitalDbTrackCsv,
  type VitalDbCaseInfo,
} from "@/lib/eeg/vitaldb";
import { MIN_POINTS, MIN_SESSIONS } from "@/lib/eeg/bis-drift";
import { runRefitNow } from "@/lib/eeg/coebis-refit.functions";
import { getExternalPriors, importVitalDb } from "@/lib/eeg/vitaldb.functions";
import type { VitalDbCasePayload } from "@/lib/eeg/vitaldb.server";
import {
  pairVitalDbCase,
  parseVitalDbWaveCsv,
  VITALDB_PAIRED_TRACKS,
  type VitalDbPairedCase,
} from "@/lib/eeg/vitaldb-waveform";
import {
  assessGateCoverage,
  validatePairedCases,
  type GateCoverage,
} from "@/lib/eeg/vitaldb-validation";
import {
  getPairedLineageCounts,
  importVitalDbPaired,
} from "@/lib/eeg/vitaldb-waveform.functions";
import type { VitalDbPairedPayload } from "@/lib/eeg/vitaldb-waveform.server";


const GROUP_LABEL: Record<string, string> = {
  age: "Age band",
  sex: "Sex",
  regimen: "Regimen",
  frailty: "Frailty (from ASA)",
};

/** Case id from a VitalDB track export filename, e.g. "1234.csv" → "1234". */
function caseIdFromName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  const digits = base.match(/\d+/g);
  return digits?.[digits.length - 1] ?? base;
}

/**
 * VitalDB is an open perioperative dataset with commercial BIS numerics and
 * pump effect-site concentrations, but no frontal EEG. Imported readings are
 * therefore kept apart from paired readings: they inform what a monitor
 * typically reads for a given age, sex, regimen and drug level — the
 * population prior — and never enter the app-to-BIS alignment itself.
 */
export function VitalDbImportPanel() {
  const [clinical, setClinical] = useState<Map<string, VitalDbCaseInfo> | null>(null);
  const [clinicalName, setClinicalName] = useState<string | null>(null);
  const clinicalRef = useRef<HTMLInputElement>(null);
  const tracksRef = useRef<HTMLInputElement>(null);
  const waveRef = useRef<HTMLInputElement>(null);

  const runImport = useServerFn(importVitalDb);
  const runPriors = useServerFn(getExternalPriors);
  const queryClient = useQueryClient();

  const runPairedImport = useServerFn(importVitalDbPaired);
  const runPairedCounts = useServerFn(getPairedLineageCounts);
  const runRefit = useServerFn(runRefitNow);

  const priors = useQuery({
    queryKey: ["external-priors"],
    queryFn: () => runPriors({}),
  });

  const pairedLineages = useQuery({
    queryKey: ["paired-lineage-counts"],
    queryFn: () => runPairedCounts({}),
  });

  const importMutation = useMutation({
    mutationFn: async (files: File[]) => {
      if (!clinical) throw new Error("Load the VitalDB clinical table first.");
      const cases: VitalDbCasePayload[] = [];
      let unmatched = 0;
      for (const file of files) {
        const caseId = caseIdFromName(file.name);
        const info = clinical.get(caseId);
        if (!info) {
          unmatched++;
          continue;
        }
        const samples = parseVitalDbTrackCsv(await file.text());
        const mapped = mapVitalDbCase(info, samples, { strideSeconds: 10, minSqi: 50 });
        if (mapped.points.length) {
          cases.push({
            caseRef: mapped.caseRef,
            covariates: mapped.covariates,
            points: mapped.points,
          });
        }
      }
      if (!cases.length) {
        throw new Error(
          unmatched
            ? "No track file matched a case id in the clinical table."
            : "No usable BIS readings in the selected files.",
        );
      }
      const result = await runImport({ data: { cases } });
      return { ...result, unmatched };
    },
    onSuccess: (result) => {
      toast.success(`Imported ${result.inserted} reference readings from ${result.cases} cases`, {
        description: [
          result.skipped ? `${result.skipped} were already present.` : null,
          result.unmatched ? `${result.unmatched} files had no matching case row.` : null,
        ]
          .filter(Boolean)
          .join(" "),
      });
      void priors.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Import failed."),
  });

  // Waveform files carry the EEG itself, so they are replayed through the app
  // estimator and stored as paired readings the refit can train on.
  const pairedMutation = useMutation({
    mutationFn: async (files: File[]) => {
      if (!clinical) throw new Error("Load the VitalDB clinical table first.");
      const replayed: VitalDbPairedCase[] = [];
      let unmatched = 0;
      for (const file of files) {
        const caseId = caseIdFromName(file.name);
        const info = clinical.get(caseId);
        if (!info) {
          unmatched++;
          continue;
        }
        const text = await file.text();
        const wave = parseVitalDbWaveCsv(text);
        const numerics = parseVitalDbTrackCsv(text);
        replayed.push(
          pairVitalDbCase(info, wave, numerics, {
            strideSeconds: 10,
            minSqi: 50,
            toleranceSeconds: 2,
          }),
        );
      }

      // Validate before writing: a replay always yields something, but only
      // cases whose pairs are real, simultaneous and spread over the case are
      // worth training COEBIS on.
      const validation = validatePairedCases(replayed);
      const accepted = new Set(validation.acceptedCaseRefs);
      const cases: VitalDbPairedPayload[] = replayed
        .filter((c) => accepted.has(c.caseRef))
        .map((c) => ({
          caseRef: c.caseRef,
          lineageKey: c.lineageKey,
          covariates: c.covariates,
          points: c.points,
        }));
      const unusable = validation.rejectedCases;

      if (!cases.length) {
        throw new Error(
          unmatched && !replayed.length
            ? "No waveform file matched a case id in the clinical table."
            : validation.summary,
        );
      }
      const result = await runPairedImport({ data: { cases } });

      // New pairs only matter once a lineage clears the sufficiency gate, so
      // report coverage explicitly and refit straight away when the import
      // actually crossed it — otherwise the Model performance page would keep
      // showing the pre-import fit until the next scheduled run.
      let refit: { summary: string; modelsPromoted: number; error: string | null } | null = null;
      let coverage: GateCoverage | null = null;
      if (result.inserted > 0) {
        const counts = await runPairedCounts({});
        coverage = assessGateCoverage(counts, result.lineages);
        if (coverage.ready) {
          refit = await runRefit({});
        }
      }
      return { ...result, unusable, unmatched, refit, validation, coverage };
    },
    onSuccess: (result) => {
      toast.success(
        `Replayed ${result.cases} cases into ${result.inserted} paired readings`,
        {
          description: [
            `Lineage ${result.lineages.join(", ")}.`,
            result.validation.summary,
            result.skipped ? `${result.skipped} were already present.` : null,
            result.unmatched ? `${result.unmatched} files had no matching case row.` : null,
            result.refit
              ? `Refit ran: ${result.refit.summary}`
              : (result.coverage?.summary ?? null),
          ]
            .filter(Boolean)
            .join(" "),
        },
      );
      if (result.refit?.error) {
        toast.error(`The refit failed: ${result.refit.error}`);
      } else if (result.refit) {
        toast.info(
          result.refit.modelsPromoted
            ? `${result.refit.modelsPromoted} model version promoted — Model performance updated.`
            : "Refit ran but no version beat the current fit, so nothing was promoted.",
        );
      }
      void pairedLineages.refetch();
      // Refresh the pages that read the fit, so Model performance shows the
      // before/after without a manual reload.
      void queryClient.invalidateQueries({ queryKey: ["model-performance"] });
      void queryClient.invalidateQueries({ queryKey: ["coebis-refit-overview"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Replay failed."),
  });

  const lastPaired = pairedMutation.data ?? null;


  return (
    <section className="panel p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Database className="size-4 text-signal" /> Import VitalDB reference cases
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        VitalDB publishes thousands of surgical cases with commercial BIS, SEF, suppression ratio
        and modelled effect-site concentrations. It carries no raw EEG, so these readings are held
        separately from your paired readings: they set the population expectation for each age
        band, sex, regimen and drug level, which your own paired readings then personalise. Download{" "}
        <code className="rounded bg-muted px-1">https://api.vitaldb.net/cases</code> for the
        clinical table, and per-case tracks as{" "}
        <code className="rounded bg-muted px-1">
          https://api.vitaldb.net/&#123;caseid&#125;?tracks=BIS/BIS,BIS/SEF,BIS/SR,BIS/EMG,BIS/SQI,Orchestra/PPF20_CE,Orchestra/RFTN20_CE
        </code>
        , saving each as <code className="rounded bg-muted px-1">&#123;caseid&#125;.csv</code>.
      </p>

      <input
        ref={clinicalRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const parsed = parseVitalDbClinicalCsv(await file.text());
          if (!parsed.size) {
            toast.error("That file has no caseid column — is it the VitalDB clinical table?");
            return;
          }
          setClinical(parsed);
          setClinicalName(`${file.name} · ${parsed.size} cases`);
        }}
      />
      <input
        ref={tracksRef}
        type="file"
        accept=".csv,text/csv"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) importMutation.mutate(files);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          onClick={() => clinicalRef.current?.click()}
        >
          1. Clinical table
        </Button>
        <Button
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => tracksRef.current?.click()}
          disabled={!clinical || importMutation.isPending}
        >
          {importMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          2. Case track files
        </Button>
        {clinicalName ? (
          <span className="text-xs text-muted-foreground">{clinicalName}</span>
        ) : null}
      </div>

      <input
        ref={waveRef}
        type="file"
        accept=".csv,text/csv"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) pairedMutation.mutate(files);
        }}
      />

      <div className="mt-3 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => waveRef.current?.click()}
            disabled={!clinical || pairedMutation.isPending}
          >
            {pairedMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            3. Raw waveform files → paired readings
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Export with{" "}
          <code className="rounded bg-muted px-1">tracks={VITALDB_PAIRED_TRACKS}</code>. The EEG is
          replayed through this app&apos;s own estimator, so each monitor BIS gets an app index for
          the same second — the pairing COEBIS refits on. Filed under its own bedside lineage, never
          mixed with Muse fits.
        </p>
        {pairedLineages.data?.length ? (
          <table className="mt-2 w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-left font-medium">Paired lineage</th>
                <th className="py-1 text-right font-medium">Cases</th>
                <th className="py-1 text-right font-medium">Readings</th>
              </tr>
            </thead>
            <tbody>
              {pairedLineages.data.map((row) => (
                <tr key={row.lineageKey} className="border-t border-border/60">
                  <td className="py-1 font-mono">{row.lineageKey}</td>
                  <td className="py-1 text-right tabular-nums">{row.cases}</td>
                  <td
                    className={`py-1 text-right tabular-nums ${
                      row.readings >= 30 && row.cases >= 3 ? "text-emerald-500" : ""
                    }`}
                  >
                    {row.readings}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>


      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">
          {priors.data?.points
            ? `${priors.data.points.toLocaleString()} reference readings from ${priors.data.cases} cases in the pool.`
            : "No external reference readings yet."}
        </p>
        {priors.data?.groups.length ? (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">Covariate</th>
                  <th className="py-1 text-left font-medium">Level</th>
                  <th className="py-1 text-right font-medium">Cases</th>
                  <th className="py-1 text-right font-medium">Readings</th>
                  <th className="py-1 text-right font-medium">Mean BIS</th>
                  <th className="py-1 text-right font-medium">Mean propofol Ce</th>
                </tr>
              </thead>
              <tbody>
                {priors.data.groups.map((g) => (
                  <tr key={`${g.group}-${g.level}`} className="border-t border-border/60">
                    <td className="py-1">{GROUP_LABEL[g.group] ?? g.group}</td>
                    <td className="py-1">{g.level}</td>
                    <td className="py-1 text-right tabular-nums">{g.cases}</td>
                    <td className="py-1 text-right tabular-nums">{g.n}</td>
                    <td className="py-1 text-right tabular-nums">{g.meanBis}</td>
                    <td className="py-1 text-right tabular-nums">
                      {g.meanPropofolCe ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">
              Levels backed by only one or two cases describe those patients, not a population.
              Frailty here is derived from ASA grade and is an approximation.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
