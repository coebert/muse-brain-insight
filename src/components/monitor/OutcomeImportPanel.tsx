import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileUp, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { importOutcomeExport } from "@/lib/eeg/outcomes.functions";

type Result = Awaited<ReturnType<typeof importOutcomeExport>>;

/**
 * Bring the hospital's own recovery record in as a file, matched to recordings
 * by case code. Nothing is written until the match has been shown and
 * confirmed, and any file carrying a patient identifier is refused.
 */
export function OutcomeImportPanel() {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const run = useServerFn(importOutcomeExport);

  const mutation = useMutation({
    mutationFn: (dryRun: boolean) => run({ data: { csv, dryRun } }),
    onSuccess: (r) => {
      setResult(r);
      if (!r.dryRun) void queryClient.invalidateQueries({ queryKey: ["outcome-report"] });
    },
  });

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setCsv(await file.text());
    setResult(null);
  }

  const canApply = result?.dryRun && result.matched.length > 0;

  return (
    <section className="panel p-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <FileUp className="size-4 text-signal" /> Bring in the hospital's recovery record
      </h2>
      <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
        Export one row per case from the ward or discharge record with columns{" "}
        <code>case_code, delirium, delirium_days, emergence, unplanned_icu, mortality_30d,
        los_days, notes</code>, then upload it here. Rows are matched to recordings by the case code
        you filed. No patient identifiers: a file containing a name, hospital number or date of
        birth is refused. Nothing is saved until you have seen the match and pressed apply.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          className="sr-only"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="size-4" /> Choose export file
        </Button>
        {fileName ? <span className="text-xs text-muted-foreground">{fileName}</span> : null}
      </div>

      <Textarea
        className="mt-2 h-24 font-mono text-xs"
        placeholder="…or paste the rows here"
        value={csv}
        onChange={(e) => {
          setCsv(e.target.value);
          setResult(null);
        }}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="min-h-11 sm:min-h-9"
          disabled={!csv.trim() || mutation.isPending}
          onClick={() => mutation.mutate(true)}
        >
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Check the match
        </Button>
        <Button
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={!canApply || mutation.isPending}
          onClick={() => mutation.mutate(false)}
        >
          Apply to {result?.matched.length ?? 0} case
          {result?.matched.length === 1 ? "" : "s"}
        </Button>
      </div>

      {mutation.error ? (
        <p role="alert" className="mt-2 text-sm text-critical">
          {mutation.error instanceof Error ? mutation.error.message : "Could not read the export."}
        </p>
      ) : null}

      {result ? (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3 text-sm">
          <p className={result.dryRun ? "text-muted-foreground" : "text-signal"}>
            {result.dryRun
              ? `${result.matched.length} row${result.matched.length === 1 ? "" : "s"} match a recording${
                  result.matched.some((m) => m.replaces)
                    ? `, ${result.matched.filter((m) => m.replaces).length} of which would replace an outcome already recorded`
                    : ""
                }.`
              : `Saved ${result.imported} outcome${result.imported === 1 ? "" : "s"}.`}
          </p>

          {result.matched.length ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {result.matched.slice(0, 20).map((m) => (
                <li key={m.sessionId}>
                  <span className="font-medium text-foreground">{m.caseCode}</span> · delirium{" "}
                  {m.row.delirium} · emergence {m.row.emergence}
                  {m.row.unplannedIcu ? " · unplanned ICU" : ""}
                  {m.row.mortality30d ? " · died within 30 days" : ""}
                  {m.row.lengthOfStayDays != null ? ` · ${m.row.lengthOfStayDays} d stay` : ""}
                  {m.replaces ? " · replaces an existing record" : ""}
                </li>
              ))}
            </ul>
          ) : null}

          {result.unmatched.length ? (
            <p className="text-xs text-warning">
              No recording for: {result.unmatched.slice(0, 12).join(", ")}
              {result.unmatched.length > 12 ? ` and ${result.unmatched.length - 12} more` : ""}.
            </p>
          ) : null}
          {result.stillMissing.length ? (
            <p className="text-xs text-muted-foreground">
              Still without an outcome: {result.stillMissing.slice(0, 12).join(", ")}
              {result.stillMissing.length > 12
                ? ` and ${result.stillMissing.length - 12} more`
                : ""}
              .
            </p>
          ) : null}
          {result.ignoredColumns.length ? (
            <p className="text-xs text-muted-foreground">
              Columns not used: {result.ignoredColumns.join(", ")}.
            </p>
          ) : null}
          {result.issues.length ? (
            <ul className="space-y-0.5 text-xs text-critical">
              {result.issues.slice(0, 10).map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
