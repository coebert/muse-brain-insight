import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, CheckCircle2, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ESCALATION_ROLES,
  listAlertActions,
  recordAlertAction,
  type AlertActionKind,
  type AlertActionRow,
} from "@/lib/eeg/alert-actions.functions";
import type { ClinicalAlert } from "@/lib/eeg/interpret.functions";

export function alertActionsQueryKey(sessionId?: string | null) {
  return ["alert-actions", sessionId ?? "all"] as const;
}

export function useAlertActions(sessionId?: string | null) {
  const list = useServerFn(listAlertActions);
  return useQuery({
    queryKey: alertActionsQueryKey(sessionId),
    queryFn: () => list({ data: { sessionId: sessionId ?? null } }),
    staleTime: 15_000,
  });
}

export function roleLabel(value: string | null): string {
  return ESCALATION_ROLES.find((r) => r.value === value)?.label ?? value ?? "—";
}

interface Props {
  alert: ClinicalAlert;
  sessionId?: string | null;
  context?: string | null;
}

export function AlertActions({ alert, sessionId, context }: Props) {
  const queryClient = useQueryClient();
  const record = useServerFn(recordAlertAction);
  const { data: rows } = useAlertActions(sessionId);
  const [mode, setMode] = useState<AlertActionKind | null>(null);
  const [note, setNote] = useState("");
  const [role, setRole] = useState<string>(
    alert.severity === "critical" ? "consultant_anaesthetist" : "",
  );

  const key = alert.id || alert.title;
  const history = useMemo(
    () => (rows ?? []).filter((r: AlertActionRow) => r.alert_id === key),
    [rows, key],
  );
  const acknowledged = history.some((r) => r.action === "acknowledged" || r.action === "escalated");
  const escalation = history.find((r) => r.action === "escalated");
  const resolved = history.some((r) => r.action === "resolved");

  const mutation = useMutation({
    mutationFn: (action: AlertActionKind) =>
      record({
        data: {
          alertId: key,
          title: alert.title,
          category: alert.category,
          severity: alert.severity,
          action,
          note: note.trim() || null,
          escalatedTo: action === "escalated" ? role || null : null,
          sessionId: sessionId ?? null,
          context: context ?? null,
        },
      }),
    onSuccess: (_row, action) => {
      setMode(null);
      setNote("");
      void queryClient.invalidateQueries({ queryKey: alertActionsQueryKey(sessionId) });
      toast.success(
        action === "escalated"
          ? `Escalated to ${roleLabel(role)}.`
          : action === "resolved"
            ? "Alert marked resolved."
            : "Alert acknowledged.",
      );
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save that action."),
  });

  const busy = mutation.isPending;

  return (
    <div className="mt-2 border-t border-current/15 pt-2">
      {history.length ? (
        <ul className="mb-2 space-y-0.5 text-[11px] text-muted-foreground">
          {history
            .slice()
            .reverse()
            .map((r) => (
              <li key={r.id} className="metric-value">
                {new Date(r.created_at).toLocaleTimeString()} ·{" "}
                {r.action === "escalated"
                  ? `escalated to ${roleLabel(r.escalated_to)}`
                  : r.action}
                {r.note ? ` · “${r.note}”` : ""}
              </li>
            ))}
        </ul>
      ) : null}

      {mode ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium capitalize">
              {mode === "escalated" ? "Escalate alert" : mode === "resolved" ? "Resolve alert" : "Acknowledge alert"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 w-6 p-0"
              onClick={() => setMode(null)}
              aria-label="Cancel"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          {mode === "escalated" ? (
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Route to clinician role…" />
              </SelectTrigger>
              <SelectContent>
                {ESCALATION_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value} className="text-xs">
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 1000))}
            rows={2}
            placeholder={
              mode === "escalated"
                ? "What do you want the receiving clinician to review or do?"
                : "Note — what you saw and what you did (optional)"
            }
            className="text-xs"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-7 px-3 text-[11px]"
              disabled={busy || (mode === "escalated" && !role)}
              onClick={() => mutation.mutate(mode)}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {mode === "escalated" ? "Send escalation" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {resolved
              ? "Resolved"
              : escalation
                ? `Escalated to ${roleLabel(escalation.escalated_to)}`
                : acknowledged
                  ? "Acknowledged"
                  : "Unacknowledged"}
          </span>
          {!acknowledged ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={busy}
              onClick={() => setMode("acknowledged")}
            >
              <CheckCircle2 className="h-3 w-3" /> Acknowledge
            </Button>
          ) : null}
          {!resolved ? (
            <Button
              size="sm"
              variant={alert.severity === "critical" && !escalation ? "default" : "outline"}
              className="h-7 px-2 text-[11px]"
              disabled={busy}
              onClick={() => setMode("escalated")}
            >
              {alert.severity === "critical" ? (
                <BellRing className="h-3 w-3" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              {escalation ? "Escalate again" : "Escalate"}
            </Button>
          ) : null}
          {!resolved ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              disabled={busy}
              onClick={() => setMode("resolved")}
            >
              Resolve
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function AlertActionLog({ sessionId }: { sessionId?: string | null }) {
  const { data: rows } = useAlertActions(sessionId);
  if (!rows?.length) return null;
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Acknowledgement &amp; escalation log
      </h3>
      <ul className="mt-1 space-y-1 text-xs">
        {rows.slice(0, 15).map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="metric-value text-[11px] text-muted-foreground">
              {new Date(r.created_at).toLocaleString()}
            </span>
            <span className="font-medium">{r.alert_title || r.alert_id}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                r.action === "escalated"
                  ? "bg-critical/15 text-critical"
                  : r.action === "resolved"
                    ? "bg-muted text-muted-foreground"
                    : "bg-caution/15 text-caution"
              }`}
            >
              {r.action === "escalated" ? `→ ${roleLabel(r.escalated_to)}` : r.action}
            </span>
            {r.note ? <span className="text-muted-foreground">“{r.note}”</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}