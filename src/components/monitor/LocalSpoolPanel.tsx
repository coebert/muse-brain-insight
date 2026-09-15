/**
 * Recordings held on this machine.
 *
 * While a case runs, the waveform is written to this computer as well as held
 * in memory. If the headband drops and never returns, or the tab is closed,
 * the signal is still here and can be attached to a saved case or downloaded.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  deleteLocalSpool,
  listLocalSpools,
  pruneLocalSpools,
  type SpoolMeta,
} from "@/lib/eeg/local-raw-spool";
import { attachSpoolToSession, downloadSpool } from "@/lib/eeg/local-spool-attach";

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m} min ${s}s` : `${s}s`;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LocalSpoolPanel() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [spools, setSpools] = useState<SpoolMeta[] | null>(null);
  const [target, setTarget] = useState<Record<string, string>>({});

  const refresh = async () => {
    await pruneLocalSpools();
    setSpools(await listLocalSpools());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const sessions = useQuery({
    queryKey: ["recent-sessions-for-spool"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_sessions")
        .select("id, case_code, started_at, duration_seconds")
        .order("started_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });

  const attach = useMutation({
    mutationFn: async ({ spoolId, sessionId }: { spoolId: string; sessionId: string }) => {
      if (!user?.id) throw new Error("Sign in first.");
      return attachSpoolToSession(spoolId, sessionId, user.id);
    },
    onSuccess: (result) => {
      toast.success(`Waveform attached — ${minutes(result.seconds)} of signal.`);
      void queryClient.invalidateQueries({ queryKey: ["session-raw-traces"] });
      void refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (spoolId: string) => deleteLocalSpool(spoolId),
    onSuccess: () => void refresh(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recordings kept on this computer</CardTitle>
        <CardDescription>
          The EEG waveform is written here as the case runs, so a headband that drops out — or a
          closed tab — does not lose it. Recordings are removed automatically after two weeks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {spools == null && <p className="text-sm text-muted-foreground">Looking…</p>}
        {spools?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing held locally. A copy appears here as soon as a recording starts.
          </p>
        )}
        {spools?.map((spool) => (
          <div key={spool.id} className="rounded-lg border border-border/60 p-3 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="font-medium">
                  {spool.caseCode ?? (spool.device || "Recording")}
                  {spool.attachedSessionId && (
                    <span className="ml-2 text-xs text-muted-foreground">already saved</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(spool.startedAt).toLocaleString()} · {minutes(spool.seconds)} ·{" "}
                  {megabytes(spool.bytes)} · {spool.channels.join(", ")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={target[spool.id] ?? ""}
                onValueChange={(value) => setTarget((prev) => ({ ...prev, [spool.id]: value }))}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue placeholder="Attach to a saved case…" />
                </SelectTrigger>
                <SelectContent>
                  {(sessions.data ?? []).map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      {session.case_code ?? session.id.slice(0, 8)} ·{" "}
                      {new Date(session.started_at as string).toLocaleDateString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!target[spool.id] || attach.isPending}
                onClick={() =>
                  attach.mutate({ spoolId: spool.id, sessionId: target[spool.id] as string })
                }
              >
                Attach
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void downloadSpool(spool.id, spool.caseCode ?? spool.id.slice(0, 8))}
              >
                Download
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(spool.id)}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
