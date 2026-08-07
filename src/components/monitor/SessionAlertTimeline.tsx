import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  Flag,
  Send,
  SignalZero,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";

import { formatClock } from "@/lib/eeg/format";
import {
  listSessionAlertFeedback,
  type AlertFeedbackRow,
} from "@/lib/eeg/alert-feedback.functions";
import { useAlertActions, roleLabel, stanceLabel } from "@/components/monitor/AlertActions";
import type { AlertActionRow } from "@/lib/eeg/alert-actions.functions";
import type { AlertEvidence } from "@/lib/eeg/interpret.functions";
import {
  assessEvidence,
  assessWindowCoverage,
  DEFAULT_QUALITY_THRESHOLDS,
  epochCadence,
  worstLevel,
  type CoverageEpoch,
  type EvidenceCompleteness,
  type QualityThresholds,
  type WindowCoverage,
} from "@/lib/eeg/coverage";

interface TimelineEntry {
  alertId: string;
  title: string;
  category: string;
  severity: string;
  /** Session-relative window derived from the evidence snapshot, when available. */
  windowStart: number | null;
  windowEnd: number | null;
  firstSeen: string;
  evidence: AlertEvidence[];
  actions: AlertActionRow[];
  feedback: AlertFeedbackRow[];
  /** EEG coverage inside the alert window; null when the window is unknown. */
  coverage: WindowCoverage | null;
  evidenceQuality: EvidenceCompleteness;
  dataLevel: "ok" | "partial" | "insufficient";
}

const SEVERITY_CLASS: Record<string, string> = {
  critical: "border-critical/50 bg-critical/10 text-critical",
  warning: "border-caution/50 bg-caution/10 text-caution",
  advisory: "border-border bg-muted/40 text-muted-foreground",
};

const STANCE_CLASS: Record<string, string> = {
  agree: "bg-success/15 text-success",
  partial: "bg-caution/15 text-caution",
  override: "bg-critical/15 text-critical",
  defer: "bg-muted text-muted-foreground",
};

const DATA_CLASS: Record<string, string> = {
  ok: "border-success/40 bg-success/10 text-success",
  partial: "border-caution/50 bg-caution/10 text-caution",
  insufficient: "border-critical/50 bg-critical/10 text-critical",
};

const DATA_LABEL: Record<string, string> = {
  ok: "Data complete",
  partial: "Partial data",
  insufficient: "Insufficient data",
};

/** Hatched overlay marking windows whose EEG or evidence is incomplete. */
const HATCH = "repeating-linear-gradient(45deg, rgba(255,255,255,0.35) 0 2px, transparent 2px 5px)";

function windowOf(evidence: AlertEvidence[]): { start: number | null; end: number | null } {
  const starts = evidence
    .map((e) => e.windowStartSeconds)
    .filter((v): v is number => typeof v === "number");
  const ends = evidence
    .map((e) => e.windowEndSeconds)
    .filter((v): v is number => typeof v === "number");
  return {
    start: starts.length ? Math.min(...starts) : null,
    end: ends.length ? Math.max(...ends) : null,
  };
}

/**
 * Chronological review of every alert raised in a saved session: the evidence
 * snapshot captured at the time, the time window it covered, the clinician's
 * acknowledge/escalate rationale and the feedback verdict that followed.
 */
export function SessionAlertTimeline({
  sessionId,
  durationSeconds,
  selectedAlertId = null,
  onSelectAlert,
  onWindowsChange,
  cursor = null,
  epochs = [],
  thresholds = DEFAULT_QUALITY_THRESHOLDS,
}: {
  sessionId: string | null;
  durationSeconds: number;
  /** Alert currently focused by the timeline scrubber. */
  selectedAlertId?: string | null;
  onSelectAlert?: (alertId: string | null) => void;
  /** Publishes the derived alert windows so a scrubber can step through them. */
  onWindowsChange?: (
    windows: { alertId: string; title: string; severity: string; start: number; end: number }[],
  ) => void;
  /** Session-relative scrubber position, drawn on the strip. */
  cursor?: number | null;
  /** Stored epochs for the session, used to flag windows with missing EEG data. */
  epochs?: CoverageEpoch[];
  /** Clinician-configured data-quality thresholds. */
  thresholds?: QualityThresholds;
}) {
  const { data: actions, isLoading: actionsLoading } = useAlertActions(sessionId);
  const listFeedback = useServerFn(listSessionAlertFeedback);
  const { data: feedback } = useQuery({
    queryKey: ["alert-feedback", "session", sessionId ?? "none"],
    enabled: Boolean(sessionId),
    queryFn: () => listFeedback({ data: { sessionId } }),
    staleTime: 15_000,
  });

  const entries = useMemo<TimelineEntry[]>(() => {
    const map = new Map<string, TimelineEntry>();
    const cadence = epochCadence(epochs);
    const ensure = (
      id: string,
      seed: { title: string; category: string; severity: string; createdAt: string },
    ): TimelineEntry => {
      let e = map.get(id);
      if (!e) {
        e = {
          alertId: id,
          title: seed.title || id,
          category: seed.category,
          severity: seed.severity,
          windowStart: null,
          windowEnd: null,
          firstSeen: seed.createdAt,
          evidence: [],
          actions: [],
          feedback: [],
          coverage: null,
          evidenceQuality: { total: 0, incomplete: 0, reasons: [], level: "insufficient" },
          dataLevel: "insufficient",
        };
        map.set(id, e);
      }
      if (seed.createdAt < e.firstSeen) e.firstSeen = seed.createdAt;
      return e;
    };

    for (const a of actions ?? []) {
      const e = ensure(a.alert_id, {
        title: a.alert_title,
        category: a.alert_category,
        severity: a.alert_severity,
        createdAt: a.created_at,
      });
      e.actions.push(a);
      const snap = Array.isArray(a.evidence_snapshot) ? a.evidence_snapshot : [];
      if (snap.length > e.evidence.length) e.evidence = snap;
    }
    for (const f of feedback ?? []) {
      const e = ensure(f.alert_id, {
        title: f.alert_title,
        category: f.alert_category,
        severity: f.alert_severity,
        createdAt: f.created_at,
      });
      e.feedback.push(f);
    }
    for (const e of map.values()) {
      const w = windowOf(e.evidence);
      e.windowStart = w.start;
      e.windowEnd = w.end;
      e.actions.sort((a, b) => a.created_at.localeCompare(b.created_at));
      e.feedback.sort((a, b) => a.created_at.localeCompare(b.created_at));
      e.evidenceQuality = assessEvidence(e.evidence, thresholds);
      e.coverage =
        e.windowStart == null || !epochs.length
          ? null
          : assessWindowCoverage(
              epochs,
              e.windowStart,
              e.windowEnd ?? e.windowStart,
              cadence,
              thresholds,
            );
      e.dataLevel = worstLevel(
        e.evidenceQuality.level,
        e.coverage ? e.coverage.level : epochs.length ? "insufficient" : "partial",
      );
    }
    return [...map.values()].sort((a, b) => {
      const at = a.windowStart ?? Number.POSITIVE_INFINITY;
      const bt = b.windowStart ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.firstSeen.localeCompare(b.firstSeen);
    });
  }, [actions, feedback, epochs, thresholds]);

  const span = Math.max(durationSeconds, 1);

  useEffect(() => {
    if (!onWindowsChange) return;
    onWindowsChange(
      entries
        .filter((e) => e.windowStart != null)
        .map((e) => ({
          alertId: e.alertId,
          title: e.title,
          severity: e.severity,
          start: e.windowStart as number,
          end: e.windowEnd ?? (e.windowStart as number),
          dataLevel: e.dataLevel,
        })),
    );
  }, [entries, onWindowsChange]);

  const incompleteCount = entries.filter((e) => e.dataLevel !== "ok").length;

  return (
    <section className="panel px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Alert &amp; decision timeline</h2>
        <span className="text-xs text-muted-foreground">
          {entries.length} alert{entries.length === 1 ? "" : "s"} with captured evidence and
          decisions
          {entries.length ? (
            <>
              {" · "}
              <span className={incompleteCount ? "text-caution" : "text-success"}>
                {incompleteCount ? `${incompleteCount} with missing data` : "all fully evidenced"}
              </span>
            </>
          ) : null}
        </span>
      </div>

      {!entries.length ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {actionsLoading
            ? "Loading decisions…"
            : "No acknowledgements, escalations or feedback recorded for this case yet. Run an AI review and action the alerts to build the timeline."}
        </p>
      ) : (
        <>
          {/* Session-relative scatter of alert windows */}
          <div className="mt-3">
            <div className="relative h-8 rounded border border-border bg-muted/20">
              {entries.map((e) =>
                e.windowStart == null ? null : (
                  <button
                    key={`bar-${e.alertId}`}
                    type="button"
                    title={`${e.title} · ${formatClock(e.windowStart)}${
                      e.dataLevel === "ok" ? "" : ` · ${DATA_LABEL[e.dataLevel]}`
                    }`}
                    onClick={() => onSelectAlert?.(e.alertId)}
                    className={`absolute top-1 bottom-1 rounded-sm border ${
                      SEVERITY_CLASS[e.severity] ?? SEVERITY_CLASS["advisory"]
                    } ${selectedAlertId === e.alertId ? "ring-2 ring-signal" : ""} ${
                      e.dataLevel === "insufficient" ? "border-dashed" : ""
                    }`}
                    style={{
                      left: `${Math.min(99, (e.windowStart / span) * 100)}%`,
                      width: `${Math.max(
                        0.8,
                        (((e.windowEnd ?? e.windowStart) - e.windowStart) / span) * 100,
                      )}%`,
                      ...(e.dataLevel === "ok" ? {} : { backgroundImage: HATCH }),
                    }}
                  />
                ),
              )}
              {cursor == null ? null : (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-signal"
                  style={{ left: `${Math.min(100, Math.max(0, (cursor / span) * 100))}%` }}
                />
              )}
            </div>
            <div className="mt-1 flex justify-between text-xs text-muted-foreground">
              <span>00:00</span>
              <span>{formatClock(span)}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Hatched bars mark windows with incomplete EEG coverage or evidence.
            </p>
          </div>

          <ol className="mt-3 space-y-2 border-l border-border pl-3">
            {entries.map((e) => (
              <li key={e.alertId} className="relative">
                <span
                  className={`absolute -left-[19px] top-2 size-2.5 rounded-full border ${
                    SEVERITY_CLASS[e.severity] ?? SEVERITY_CLASS["advisory"]
                  }`}
                />
                <div
                  className={`rounded-md border bg-card/40 px-3 py-2 ${
                    selectedAlertId === e.alertId ? "border-signal" : "border-border"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectAlert?.(e.alertId)}
                    className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 text-left"
                  >
                    <span className="metric-value text-xs text-muted-foreground">
                      <Clock className="mr-1 inline size-3" />
                      {e.windowStart == null
                        ? new Date(e.firstSeen).toLocaleTimeString()
                        : `${formatClock(e.windowStart)}–${formatClock(e.windowEnd ?? e.windowStart)}`}
                    </span>
                    <span className="text-sm font-medium">{e.title}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs uppercase tracking-wide ${
                        SEVERITY_CLASS[e.severity] ?? SEVERITY_CLASS["advisory"]
                      }`}
                    >
                      {e.severity}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {e.category.replace(/_/g, " ")}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs uppercase tracking-wide ${
                        DATA_CLASS[e.dataLevel]
                      }`}
                    >
                      {e.dataLevel === "ok" ? (
                        <CheckCircle2 className="size-3" />
                      ) : e.dataLevel === "insufficient" ? (
                        <SignalZero className="size-3" />
                      ) : (
                        <AlertTriangle className="size-3" />
                      )}
                      {DATA_LABEL[e.dataLevel]}
                    </span>
                  </button>

                  {e.dataLevel === "ok" ? null : (
                    <ul className="mt-2 space-y-0.5 rounded-md border border-dashed border-border bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
                      {e.coverage ? (
                        <>
                          <li>
                            EEG coverage {Math.round(e.coverage.fraction * 100)}% (
                            {e.coverage.present}/{e.coverage.expected} epochs
                            {e.coverage.largestGapSeconds >= 1
                              ? `, largest gap ${Math.round(e.coverage.largestGapSeconds)} s`
                              : ""}
                            )
                          </li>
                          {e.coverage.spectrumMissingFraction > 0 ? (
                            <li>
                              No spectrum stored for{" "}
                              {Math.round(e.coverage.spectrumMissingFraction * 100)}% of the window
                              — the DSA cannot be reviewed here.
                            </li>
                          ) : null}
                          {e.coverage.missingMetrics.length ? (
                            <li>Metrics unavailable: {e.coverage.missingMetrics.join(", ")}</li>
                          ) : null}
                        </>
                      ) : (
                        <li>
                          No time window on this alert, so its EEG coverage cannot be checked.
                        </li>
                      )}
                      {e.evidenceQuality.reasons.map((r) => (
                        <li key={`${e.alertId}-gap-${r}`}>Evidence: {r}</li>
                      ))}
                    </ul>
                  )}

                  {e.evidence.length ? (
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                      {e.evidence.slice(0, 6).map((ev, i) => (
                        <li key={`${e.alertId}-ev-${i}`} className="text-xs">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate">
                              {ev.feature}
                              <span className="metric-value ml-1 text-muted-foreground">
                                {ev.value && String(ev.value).trim() ? (
                                  ev.value
                                ) : (
                                  <span className="text-caution">no value</span>
                                )}
                              </span>
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {typeof ev.windowStartSeconds === "number"
                                ? ev.direction
                                : `${ev.direction} · no window`}
                            </span>
                          </div>
                          <div className="mt-0.5 h-1 rounded-full bg-muted">
                            <div
                              className="h-1 rounded-full bg-signal"
                              style={{
                                width: `${Math.round(Math.min(1, Math.max(0, ev.weight || 0)) * 100)}%`,
                              }}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      No evidence snapshot was captured for this alert.
                    </p>
                  )}

                  <ul className="mt-2 space-y-1 text-xs">
                    {e.actions.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
                        {a.action === "escalated" ? (
                          <Send className="size-3 text-critical" />
                        ) : a.action === "resolved" ? (
                          <CircleDashed className="size-3 text-muted-foreground" />
                        ) : (
                          <CheckCircle2 className="size-3 text-caution" />
                        )}
                        <span className="metric-value text-muted-foreground">
                          {new Date(a.created_at).toLocaleTimeString()}
                        </span>
                        <span>
                          {a.action === "escalated"
                            ? `Escalated to ${roleLabel(a.escalated_to)}`
                            : a.action === "resolved"
                              ? "Resolved"
                              : "Acknowledged"}
                        </span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[11px] uppercase tracking-wide ${
                            STANCE_CLASS[a.override_stance ?? "agree"] ?? "bg-muted"
                          }`}
                        >
                          {stanceLabel(a.override_stance)}
                        </span>
                        {a.override_rationale ? (
                          <span className="w-full italic text-muted-foreground">
                            “{a.override_rationale}”
                          </span>
                        ) : null}
                        {a.cited_features?.length ? (
                          <span className="w-full text-xs text-muted-foreground">
                            Linked evidence: {a.cited_features.join(" · ")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                    {e.feedback.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-baseline gap-x-2">
                        {f.verdict === "correct" ? (
                          <ThumbsUp className="size-3 text-success" />
                        ) : f.verdict === "incorrect" ? (
                          <ThumbsDown className="size-3 text-critical" />
                        ) : (
                          <Flag className="size-3 text-muted-foreground" />
                        )}
                        <span className="metric-value text-muted-foreground">
                          {new Date(f.created_at).toLocaleTimeString()}
                        </span>
                        <span>Marked {f.verdict}</span>
                        {f.reason ? (
                          <span className="w-full italic text-muted-foreground">“{f.reason}”</span>
                        ) : null}
                      </li>
                    ))}
                    {!e.actions.length && !e.feedback.length ? (
                      <li className="text-muted-foreground">No decision recorded.</li>
                    ) : null}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
