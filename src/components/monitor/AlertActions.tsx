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
  OVERRIDE_STANCES,
  listAlertActions,
  recordAlertAction,
  type AlertActionKind,
  type AlertActionRow,
  type OverrideStance,
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

export function stanceLabel(value: string | null | undefined): string {
  return OVERRIDE_STANCES.find((s) => s.value === value)?.label ?? "Agree with the AI read";
}

const STANCE_CLASS: Record<string, string> = {
  agree: "bg-success/15 text-success",
  partial: "bg-caution/15 text-caution",
  override: "bg-critical/15 text-critical",
  defer: "bg-muted text-muted-foreground",
};

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
  const [stance, setStance] = useState<OverrideStance>("agree");
  const [rationale, setRationale] = useState("");
  const [cited, setCited] = useState<string[]>([]);
  const [role, setRole] = useState<string>(
    alert.severity === "critical" ? "consultant_anaesthetist" : "",
  );

  const evidence = alert.evidence ?? [];
  const needsRationale = stance !== "agree" && mode !== "resolved";

  function resetForm() {
    setMode(null);
    setNote("");
    setRationale("");
    setStance("agree");
    setCited([]);
  }

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
          overrideStance: stance,
          overrideRationale: rationale.trim() || null,
          citedFeatures: cited,
          alertConfidence: alert.confidence ?? "unknown",
          evidenceSnapshot: evidence,
        },
      }),
    onSuccess: (_row, action) => {
      resetForm();
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
              <li key={r.id} className="space-y-0.5">
                <div className="metric-value">
                  {new Date(r.created_at).toLocaleTimeString()} ·{" "}
                  {r.action === "escalated"
                    ? `escalated to ${roleLabel(r.escalated_to)}`
                    : r.action}
                  {r.override_stance && r.override_stance !== "agree" ? (
                    <span
                      className={`ml-1 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                        STANCE_CLASS[r.override_stance] ?? "bg-muted"
                      }`}
                    >
                      {r.override_stance}
                    </span>
                  ) : null}
                  {r.note ? ` · “${r.note}”` : ""}
                </div>
                {r.override_rationale ? (
                  <div className="pl-2 italic">Rationale: “{r.override_rationale}”</div>
                ) : null}
                {r.cited_features?.length ? (
                  <div className="pl-2">Citing: {r.cited_features.join(", ")}</div>
                ) : null}
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
              onClick={resetForm}
              aria-label="Cancel"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Your position on the AI read
            </span>
            <Select value={stance} onValueChange={(v) => setStance(v as OverrideStance)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OVERRIDE_STANCES.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {OVERRIDE_STANCES.find((s) => s.value === stance)?.hint}
            </p>
          </div>
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Clinician rationale{needsRationale ? " (required)" : " (optional)"}
            </span>
            <Textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value.slice(0, 2000))}
              rows={2}
              placeholder={
                stance === "agree"
                  ? "Why this alert is clinically valid and what you are doing about it…"
                  : "Why the clinical picture differs from the AI read (drugs, stimulation, artefact, comorbidity…)"
              }
              className="text-xs"
            />
          </div>
          {evidence.length ? (
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Evidence features your rationale refers to
              </span>
              <div className="flex flex-wrap gap-1">
                {evidence.map((e) => {
                  const on = cited.includes(e.feature);
                  return (
                    <button
                      key={e.feature}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setCited((prev) =>
                          prev.includes(e.feature)
                            ? prev.filter((f) => f !== e.feature)
                            : [...prev, e.feature],
                        )
                      }
                      className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                        on
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {e.feature} · {e.value}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
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
              disabled={
                busy ||
                (mode === "escalated" && !role) ||
                (needsRationale && !rationale.trim())
              }
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
          <li key={r.id} className="space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
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
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                STANCE_CLASS[r.override_stance ?? "agree"] ?? "bg-muted"
              }`}
            >
              {r.override_stance ?? "agree"}
            </span>
            {r.note ? <span className="text-muted-foreground">“{r.note}”</span> : null}
            </div>
            {r.override_rationale ? (
              <p className="pl-1 text-[11px] italic text-muted-foreground">
                Rationale: “{r.override_rationale}”
              </p>
            ) : null}
            {r.cited_features?.length ? (
              <p className="pl-1 text-[10px] text-muted-foreground">
                Linked evidence: {r.cited_features.join(" · ")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}