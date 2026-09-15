import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Database, HardDrive, Hourglass, Radio } from "lucide-react";
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
import { getCaptureStats, recoverCapture } from "@/lib/eeg/auto-capture.functions";
import { HARVEST_QUIET_HOURS } from "@/lib/eeg/capture-harvest.constants";
import { LocalSpoolPanel } from "@/components/monitor/LocalSpoolPanel";

export const Route = createFileRoute("/_authenticated/_admin/capture")({
  head: () => ({
    meta: [
      { title: "Data collection — CortexTrace" },
      {
        name: "description",
        content:
          "Every recording that passes through the monitor is captured continuously and folded into the training pool, filed or not. See how much signal has been collected and what is still waiting.",
      },
      { property: "og:title", content: "Data collection — CortexTrace" },
      {
        property: "og:description",
        content:
          "Continuous capture status: recordings collected, hours of signal, and what the scheduled refit has already taken up.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CapturePage,
});

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Radio;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2 text-xs tracking-[0.12em] uppercase">
          <Icon className="size-3.5" /> {label}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function CapturePage() {
  const fetchStats = useServerFn(getCaptureStats);
  const runRecover = useServerFn(recoverCapture);
  const queryClient = useQueryClient();
  const [recovering, setRecovering] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["capture-stats"],
    queryFn: () => fetchStats(),
    refetchInterval: 30_000,
  });

  // Brings a recording that was never filed — a case lost to a headband
  // dropout — onto the timeline straight away.
  const recover = useMutation({
    mutationFn: async (captureKey: string) => {
      setRecovering(captureKey);
      return await runRecover({ data: { captureKey } });
    },
    onSuccess: (result) => {
      toast.success(`Recovered ${result.epochs.toLocaleString()} readings as a case.`);
      void queryClient.invalidateQueries({ queryKey: ["capture-stats"] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setRecovering(null),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Data collection</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every recording is written to the database while it runs, so nothing is lost when a case
          is never filed. Recordings that stay unfiled for {HARVEST_QUIET_HOURS} hours are turned
          into anonymised cases automatically and join the same training pool as filed cases. Only
          derived numbers are captured — no names, identifiers or free text ever reach this path.
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      ) : isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              icon={Radio}
              label="Recordings captured"
              value={String(data.captures)}
              hint="Every run of the monitor, filed or not"
            />
            <Stat
              icon={HardDrive}
              label="Seconds of signal"
              value={data.epochs.toLocaleString()}
              hint={`${data.hours.toFixed(1)} hours of scored EEG`}
            />
            <Stat
              icon={Database}
              label="In the training pool"
              value={String(data.inPool)}
              hint="Filed by hand or picked up automatically"
            />
            <Stat
              icon={Hourglass}
              label="Waiting"
              value={String(data.waiting)}
              hint="Still running, or not yet quiet long enough"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent recordings</CardTitle>
              <CardDescription>
                Most recent first. A recording is only picked up once it has been quiet for{" "}
                {HARVEST_QUIET_HOURS} hours, so an in-progress case shows as waiting.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing captured yet. Start the monitor and this fills as the case runs.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Headband</TableHead>
                      <TableHead>Setup</TableHead>
                      <TableHead className="text-right">Seconds</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recent.map((row) => (
                      <TableRow key={row.captureKey}>
                        <TableCell className="whitespace-nowrap">
                          {new Date(row.startedAt).toLocaleString()}
                        </TableCell>
                        <TableCell>{row.deviceName ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {row.lineageKey ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.epochs.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {row.filed ? (
                            <Badge>Filed as a case</Badge>
                          ) : row.harvested ? (
                            <Badge variant="secondary">Picked up automatically</Badge>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">Waiting</Badge>
                              {row.epochs > 0 ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={recover.isPending}
                                  onClick={() => recover.mutate(row.captureKey)}
                                >
                                  {recover.isPending && recovering === row.captureKey
                                    ? "Recovering…"
                                    : "Recover as a case"}
                                </Button>
                              ) : null}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <LocalSpoolPanel />
    </div>
  );
}
