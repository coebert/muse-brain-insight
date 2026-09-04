import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookMarked, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  REFERENCE_FORMATS,
  UPLOAD_LINEAGE_KEY,
  REFERENCE_KIND_LABEL,
  detectFormat,
  formatById,
  parseReferenceFile,
  type ParsedReferenceFile,
  type ReferenceFormat,
} from "@/lib/eeg/reference-library";
import {
  getReferenceLibrary,
  importReferenceFile,
} from "@/lib/eeg/reference-library.functions";
import { unseal } from "@/lib/privacy";

export const Route = createFileRoute("/_authenticated/_admin/reference")({
  head: () => ({
    meta: [
      { title: "Reference library — CortexTrace" },
      {
        name: "description",
        content:
          "Every monitor export, MOAA/S score sheet and event file the app grades itself against, what each must contain, and how to upload your own cases.",
      },
      { property: "og:title", content: "Reference library — CortexTrace" },
      {
        property: "og:description",
        content:
          "The label formats behind every accuracy claim, with columns, licences, case counts and an upload path for your own recordings.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ReferencePage,
});

function FormatCard({
  format,
  rows,
  cases,
}: {
  format: ReferenceFormat;
  rows: number;
  cases: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{format.label}</CardTitle>
          <Badge variant="outline">{REFERENCE_KIND_LABEL[format.kind]}</Badge>
          <Badge variant={rows > 0 ? "secondary" : "outline"}>
            {rows > 0
              ? `${rows.toLocaleString()} rows · ${cases.toLocaleString()} case${cases === 1 ? "" : "s"}`
              : "nothing on file yet"}
          </Badge>
        </div>
        <CardDescription>{format.provenance}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Column</TableHead>
              <TableHead>What it holds</TableHead>
              <TableHead>Units</TableHead>
              <TableHead>Needed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {format.columns.map((c) => (
              <TableRow key={c.name}>
                <TableCell className="font-mono text-[11px]">{c.name}</TableCell>
                <TableCell className="text-[11px]">{c.meaning}</TableCell>
                <TableCell className="text-[11px]">{c.units}</TableCell>
                <TableCell className="text-[11px]">{c.required ? "yes" : "optional"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-[11px] text-muted-foreground">{format.notes}</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-[11px]">{format.sample}</pre>
        <p className="text-[11px] text-muted-foreground">
          Licence: {format.licence}
          {format.licenceUrl ? (
            <>
              {" · "}
              <a className="underline" href={format.licenceUrl} target="_blank" rel="noreferrer">
                source
              </a>
            </>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}

function ReferencePage() {
  const load = useServerFn(getReferenceLibrary);
  const send = useServerFn(importReferenceFile);
  const queryClient = useQueryClient();

  const library = useQuery({
    queryKey: ["reference-library"],
    queryFn: async () => {
      const report = await load();
      return {
        ...report,
        sessions: await unseal(report.sessions, ["caseCode"]),
      };
    },
  });

  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedReferenceFile | null>(null);
  const [formatId, setFormatId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const coverage = useMemo(() => {
    const map = new Map<string, { rows: number; cases: number }>();
    for (const c of library.data?.coverage ?? []) map.set(c.formatId, { rows: c.rows, cases: c.cases });
    return map;
  }, [library.data]);

  async function onFile(file: File) {
    const text = await file.text();
    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    const guess = detectFormat(firstLine);
    const chosen = formatById(formatId) ?? guess;
    setFileName(file.name);
    if (!chosen) {
      setParsed(null);
      toast.error("That file's columns don't match any format in the library.");
      return;
    }
    setFormatId(chosen.id);
    setParsed(parseReferenceFile(chosen, text));
  }

  async function upload() {
    if (!parsed || !parsed.rows.length || !sessionId) return;
    setSaving(true);
    try {
      const outcome = await send({
        data: {
          sessionId,
          formatId: parsed.formatId,
          lineageKey: UPLOAD_LINEAGE_KEY,
          rows: parsed.rows.slice(0, 5000),
        },
      });
      toast.success(
        outcome.pairedInserted > 0
          ? `Filed ${outcome.pairedInserted} paired readings. ${outcome.note}`
          : `Filed ${outcome.labelsInserted} state labels. ${outcome.note}`,
      );
      setParsed(null);
      setFileName(null);
      await queryClient.invalidateQueries({ queryKey: ["reference-library"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That file could not be filed.");
    } finally {
      setSaving(false);
    }
  }

  const sessions = library.data?.sessions ?? [];

  return (
    <div className="min-h-dvh space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <BookMarked className="h-5 w-5" /> Reference library
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every accuracy figure in this app is measured against something recorded independently of
          it: a monitor's own index, a bedside sedation score, or an event file marking when
          consciousness was lost and regained. These are the formats it accepts, and you can add
          your own cases in any of them.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="h-4 w-4" /> Upload your own case labels
          </CardTitle>
          <CardDescription>
            Pick a file, choose the recording it belongs to, and it is read against the matching
            format below. Nothing is written until you confirm what was found.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".csv,.tsv,.txt"
              aria-label="Reference file"
              className="text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
            <select
              aria-label="File format"
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={formatId}
              onChange={(e) => setFormatId(e.target.value)}
            >
              <option value="">Detect the format</option>
              {REFERENCE_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Recording"
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            >
              <option value="">Choose a recording</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {(s.caseCode ?? "case") + ` · ${s.scoredEpochs.toLocaleString()} scored moments`}
                </option>
              ))}
            </select>
          </div>

          {parsed ? (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                <span className="font-medium">{fileName}</span> read as{" "}
                {formatById(parsed.formatId)?.label}: {parsed.rows.length.toLocaleString()} usable
                rows.
              </p>
              {parsed.missingColumns.length > 0 ? (
                <p className="text-[11px] text-destructive">
                  Missing required column{parsed.missingColumns.length === 1 ? "" : "s"}:{" "}
                  {parsed.missingColumns.join(", ")}.
                </p>
              ) : null}
              {parsed.skipped.map((s) => (
                <p key={s.reason} className="text-[11px] text-muted-foreground">
                  {s.count.toLocaleString()} rows left out — {s.reason}.
                </p>
              ))}
              {parsed.unusedColumns.length > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  Ignored columns: {parsed.unusedColumns.join(", ")}.
                </p>
              ) : null}
              <Button
                size="sm"
                disabled={saving || !parsed.rows.length || !sessionId}
                onClick={() => void upload()}
              >
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                File these against the recording
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {(["bis-monitor", "sedation-scale", "event-file"] as const).map((kind) => (
        <section key={kind} className="space-y-3">
          <h2 className="text-lg font-semibold">{REFERENCE_KIND_LABEL[kind]}s</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {REFERENCE_FORMATS.filter((f) => f.kind === kind).map((f) => (
              <FormatCard
                key={f.id}
                format={f}
                rows={coverage.get(f.id)?.rows ?? 0}
                cases={coverage.get(f.id)?.cases ?? 0}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
