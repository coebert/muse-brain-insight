import { Fragment, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ClipboardList, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatClock } from "@/lib/eeg/format";
import type { PairingCandidate, PairingMoment } from "@/lib/eeg/pairing-worklist";
import { getPairingMoments, getPairingWorklist } from "@/lib/eeg/pairing-worklist.functions";
import { recordBisPoints } from "@/lib/eeg/bis-drift.functions";

export const Route = createFileRoute("/_authenticated/pairing")({
  head: () => ({
    meta: [
      { title: "Pair monitor readings — CortexTrace" },
      {
        name: "description",
        content:
          "Recordings that hold EEG but no bedside monitor values, the moments in each worth pairing, and how many readings remain before the headband lineage can be fitted.",
      },
      { property: "og:title", content: "Pair monitor readings — CortexTrace" },
      {
        property: "og:description",
        content:
          "Close the gap to a fittable headband model by entering the monitor values recorded alongside stored EEG.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PairingPage,
});

/** One recording opened for entry, with a monitor value box per moment. */
function CaseEntry({
  candidate,
  lineageKey,
  onSaved,
}: {
  candidate: PairingCandidate;
  lineageKey: string;
  onSaved: () => void;
}) {
  const fetchMoments = useServerFn(getPairingMoments);
  const file = useServerFn(recordBisPoints);
  const [values, setValues] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);

  const moments = useQuery({
    queryKey: ["pairing-moments", candidate.sessionId, candidate.suggested],
    queryFn: () =>
      fetchMoments({
        data: { sessionId: candidate.sessionId, count: Math.max(3, candidate.suggested || 6) },
      }),
  });

  const rows: PairingMoment[] = moments.data ?? [];
  const entered = rows.filter((m) => {
    const v = Number(values[m.at]);
    return Number.isFinite(v) && v >= 0 && v <= 100;
  });

  async function save() {
    if (!entered.length) return;
    setSaving(true);
    try {
      const result = await file({
        data: {
          sessionId: candidate.sessionId,
          lineage: lineageKey,
          context: "retrospective pairing",
          points: entered.map((m) => ({
            at: m.at,
            bis: Number(values[m.at]),
            appIndex: m.appIndex,
            appSr: m.appSr,
            appSef: m.appSef,
            reliable: true,
          })),
        },
      });
      toast.success(`Filed ${result.inserted} monitor readings.`);
      setValues({});
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not file the readings.");
    } finally {
      setSaving(false);
    }
  }

  if (moments.isLoading)
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading moments…
      </p>
    );
  if (!rows.length)
    return <p className="p-4 text-sm text-muted-foreground">This recording carries no scored moments.</p>;

  return (
    <div className="space-y-3 p-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead className="text-right">App index</TableHead>
            <TableHead className="text-right">Suppression</TableHead>
            <TableHead className="text-right">SEF95</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="w-36">Monitor value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((m) => (
            <TableRow key={m.at}>
              <TableCell className="tabular-nums">{formatClock(m.at)}</TableCell>
              <TableCell className="text-right tabular-nums">{m.appIndex.toFixed(1)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {m.appSr == null ? "—" : `${Math.round(m.appSr * 100)}%`}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {m.appSef == null ? "—" : `${m.appSef.toFixed(1)} Hz`}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{m.state ?? "—"}</TableCell>
              <TableCell>
                <Input
                  inputMode="numeric"
                  placeholder="0–100"
                  value={values[m.at] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [m.at]: e.target.value }))}
                  className="h-9"
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Enter only values you read from the bedside monitor at that moment. Blank rows are skipped.
        </p>
        <Button onClick={save} disabled={!entered.length || saving} size="sm">
          {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          File {entered.length || ""} reading{entered.length === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}

function PairingPage() {
  const fetchWorklist = useServerFn(getPairingWorklist);
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  const worklist = useQuery({
    queryKey: ["pairing-worklist"],
    queryFn: () => fetchWorklist({ data: {} }),
  });

  const data = worklist.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ClipboardList className="size-6" /> Pair monitor readings
        </h1>
        <p className="text-sm text-muted-foreground">
          The headband lineage cannot be fitted from EEG alone: each reading needs the value a
          commercial monitor showed at the same moment, and those numbers can only come from the
          record. This page lists the recordings that still hold unpaired EEG, picks the moments in
          each that are worth pairing, and files what you enter straight into the training set. No
          monitor value is ever inferred.
        </p>
      </div>

      {worklist.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading worklist…</p>
      ) : worklist.isError ? (
        <p className="text-sm text-destructive">Could not load the worklist.</p>
      ) : null}

      {data ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {data.ready
                ? "Gate met — the next scheduled refit will fit this lineage"
                : `${data.shortfallPoints} more readings needed`}
            </CardTitle>
            <CardDescription>
              {data.validated} validated readings across {data.cases} cases, against a gate of{" "}
              {data.needPoints} readings across {data.needCases} cases.{" "}
              {data.unpairedRecordings} recordings hold EEG with no monitor values at all.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recording</TableHead>
                  <TableHead className="text-right">Scored epochs</TableHead>
                  <TableHead className="text-right">On file</TableHead>
                  <TableHead className="text-right">Suggested</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.candidates.map((c) => (
                  <Fragment key={c.sessionId}>
                    <TableRow>
                      <TableCell className="font-medium">
                        {c.caseCode ?? c.sessionId.slice(0, 8)}
                        <div className="text-xs text-muted-foreground">
                          {new Date(c.startedAt).toLocaleString()} ·{" "}
                          {formatClock(c.durationSeconds)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.indexEpochs.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.paired === 0 ? (
                          <Badge variant="outline">none</Badge>
                        ) : (
                          c.paired.toLocaleString()
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.suggested || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={open === c.sessionId ? "secondary" : "outline"}
                          onClick={() => setOpen(open === c.sessionId ? null : c.sessionId)}
                          disabled={c.indexEpochs === 0}
                        >
                          {open === c.sessionId ? "Close" : "Pair"}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {open === c.sessionId ? (
                      <TableRow>
                        <TableCell colSpan={5} className="bg-muted/30 p-0">
                          <CaseEntry
                            candidate={c}
                            lineageKey={data.lineageKey}
                            onSaved={() => {
                              void client.invalidateQueries({ queryKey: ["pairing-worklist"] });
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
