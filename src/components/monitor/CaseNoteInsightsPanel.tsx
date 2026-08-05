import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Check,
  Crosshair,
  Lightbulb,
  NotebookPen,
  Pencil,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  mineCaseNotes,
  type CaseNoteInsights,
  type CasePattern,
  type EegCitation,
} from "@/lib/eeg/case-notes.functions";
import { formatClock } from "@/lib/eeg/format";
import {
  patternKey as makePatternKey,
  VERDICT_LABEL,
  type PatternFeedback,
  type PatternVerdict,
} from "@/lib/eeg/pattern-feedback";
import {
  deletePatternFeedback,
  savePatternFeedback,
} from "@/lib/eeg/pattern-feedback.functions";
import {
  cohortOptions,
  DEFAULT_PATTERN_FILTERS,
  matchesFilters,
  PATTERN_TYPE_LABEL,
  patternType,
  type PatternFilters,
  type PatternType,
} from "@/lib/eeg/pattern-filters";
import { cn } from "@/lib/utils";

const STRENGTH_STYLES: Record<string, string> = {
  emerging: "bg-muted text-muted-foreground",
  moderate: "bg-caution/15 text-caution",
  strong: "bg-signal/15 text-signal",
};

const VERDICT_STYLES: Record<PatternVerdict, string> = {
  accepted: "bg-signal/15 text-signal",
  rejected: "bg-critical/15 text-critical",
  edited: "bg-caution/15 text-caution",
};

/** Timestamped EEG segments a finding rests on, each opening in Trends. */
function Citations({ citations }: { citations: EegCitation[] }) {
  if (!citations?.length) return null;
  return (
    <ul className="mt-2 space-y-1 border-l border-border pl-2.5">
      {citations.map((c, i) => (
        <li key={`${c.sessionId}-${c.startSeconds}-${i}`} className="text-xs">
          <Link
            to="/trends"
            search={{ session: c.sessionId, t: c.startSeconds }}
            className="metric-value inline-flex items-center gap-1 text-signal hover:underline"
          >
            <Crosshair className="size-3" />
            {c.caseCode} {formatClock(c.startSeconds)}–{formatClock(c.endSeconds)}
          </Link>{" "}
          <span className="text-muted-foreground">{c.why}</span>
        </li>
      ))}
    </ul>
  );
}

/** Accept / reject / reword one proposed pattern and keep the verdict. */
function PatternVerdictControls({
  pattern,
  feedback,
  onChange,
}: {
  pattern: CasePattern;
  feedback: PatternFeedback | undefined;
  onChange: (key: string, next: PatternFeedback | undefined) => void;
}) {
  const save = useServerFn(savePatternFeedback);
  const remove = useServerFn(deletePatternFeedback);
  const key = pattern.patternKey || makePatternKey(pattern.title);

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(feedback?.title || pattern.title);
  const [detail, setDetail] = useState(feedback?.detail || pattern.detail);
  const [note, setNote] = useState(feedback?.note ?? "");

  async function record(verdict: PatternVerdict, withNote = note) {
    setBusy(true);
    try {
      const res = await save({
        data: {
          patternKey: key,
          verdict,
          title: verdict === "edited" ? title : pattern.title,
          detail: verdict === "edited" ? detail : pattern.detail,
          suggestedAction: pattern.suggestedAction ?? "",
          caseCodes: pattern.caseCodes ?? [],
          note: withNote,
        },
      });
      onChange(key, res.feedback);
      setEditing(false);
      toast.success(
        verdict === "rejected"
          ? "Rejected — the AI won't propose this again."
          : verdict === "edited"
            ? "Saved your wording — the AI will use it."
            : "Accepted — the AI will build on this.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your decision.");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await remove({ data: { patternKey: key } });
      onChange(key, undefined);
      setNote("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not withdraw your decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 border-t border-border pt-2.5">
      {editing ? (
        <div className="space-y-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Pattern as you would word it"
            className="h-9 text-sm"
          />
          <Textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={3}
            placeholder="What the pattern actually says"
            className="text-sm"
          />
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Why you reworded it (optional) — the AI reads this"
            className="text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void record("edited")}>
              Save my version
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {feedback ? (
            <>
              <span
                className={cn("rounded-full px-2 py-0.5 text-xs", VERDICT_STYLES[feedback.verdict])}
              >
                {VERDICT_LABEL[feedback.verdict]}
              </span>
              {feedback.note ? (
                <span className="text-xs text-muted-foreground">“{feedback.note}”</span>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className="min-h-9"
                disabled={busy}
                onClick={() => void clear()}
              >
                <Undo2 className="size-4" /> Undo
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="min-h-9"
                disabled={busy}
                onClick={() => void record("accepted")}
              >
                <Check className="size-4 text-signal" /> Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="min-h-9"
                disabled={busy}
                onClick={() => void record("rejected")}
              >
                <X className="size-4 text-critical" /> Reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="min-h-9"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-4" /> Edit
              </Button>
              <span className="text-xs text-muted-foreground">
                Your decision trains the next analysis.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Reads the clinician's free-text case summaries, pulls out the key details
 * and looks for patterns linking them to the recorded EEG.
 */
export function CaseNoteInsightsPanel() {
  const run = useServerFn(mineCaseNotes);
  const save = useServerFn(savePatternFeedback);
  const [result, setResult] = useState<CaseNoteInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [verdicts, setVerdicts] = useState<Record<string, PatternFeedback>>({});
  const [filters, setFilters] = useState<PatternFilters>(DEFAULT_PATTERN_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  async function analyse() {
    setLoading(true);
    try {
      const res = await run({ data: { limit: 25 } });
      setResult(res);
      setVerdicts(Object.fromEntries(res.feedback.map((f) => [f.patternKey, f])));
      setSelected([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not analyse your case notes.");
    } finally {
      setLoading(false);
    }
  }

  function updateVerdict(key: string, next: PatternFeedback | undefined) {
    setVerdicts((prev) => {
      const copy = { ...prev };
      if (next) copy[key] = next;
      else delete copy[key];
      return copy;
    });
  }

  const patterns = result?.patterns ?? [];
  const keyed = patterns.map((p) => ({ p, key: p.patternKey || makePatternKey(p.title) }));
  const visible = keyed.filter(({ p, key }) => matchesFilters(p, verdicts[key], filters));
  const visibleKeys = visible.map((v) => v.key);
  const selectedVisible = selected.filter((k) => visibleKeys.includes(k));
  const allVisibleSelected = visibleKeys.length > 0 && selectedVisible.length === visibleKeys.length;

  function toggle(key: string, on: boolean) {
    setSelected((prev) => (on ? [...new Set([...prev, key])] : prev.filter((k) => k !== key)));
  }

  /** Record the same verdict on every selected, currently visible pattern. */
  async function bulkRecord(verdict: "accepted" | "rejected") {
    const targets = keyed.filter(({ key }) => selectedVisible.includes(key));
    if (!targets.length) return;
    setBulkBusy(true);
    let done = 0;
    try {
      for (const { p, key } of targets) {
        const res = await save({
          data: {
            patternKey: key,
            verdict,
            title: p.title,
            detail: p.detail,
            suggestedAction: p.suggestedAction ?? "",
            caseCodes: p.caseCodes ?? [],
            note: "",
          },
        });
        updateVerdict(key, res.feedback);
        done += 1;
      }
      setSelected([]);
      toast.success(
        `${verdict === "accepted" ? "Accepted" : "Rejected"} ${done} pattern${done === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `${err.message} (${done} saved before this)`
          : "Could not save every decision.",
      );
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <section className="panel px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <NotebookPen className="size-4 text-signal" /> Case-note intelligence
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The AI compares your cases and looks for patterns linking their details to the EEG you
            recorded. Details you have confirmed above are used as written, and every pattern you
            accept, reject or reword feeds into the next analysis.
          </p>
        </div>
        <Button onClick={analyse} disabled={loading} className="min-h-11 sm:min-h-9">
          <Sparkles className="size-4" />
          {loading ? "Reading your notes…" : "Find patterns"}
        </Button>
      </div>

      {result ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm">{result.headline}</p>
          <p className="text-xs text-muted-foreground">
            {result.notesAnalysed} written case{result.notesAnalysed === 1 ? "" : "s"} of{" "}
            {result.casesAnalysed} reviewed · {new Date(result.generatedAt).toLocaleString()}
          </p>

          {result.patterns.length ? (
            <div className="space-y-2">
              <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
                Candidate patterns
              </h3>
              {result.patterns.map((p) => {
                const key = p.patternKey || makePatternKey(p.title);
                const fb = verdicts[key];
                return (
                <article
                  key={key || p.title}
                  className={cn(
                    "rounded-md border border-border px-3 py-2.5",
                    fb?.verdict === "rejected" && "opacity-60",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Lightbulb className="size-4 text-caution" />
                    <h4 className="text-sm font-medium">
                      {fb?.verdict === "edited" && fb.title ? fb.title : p.title}
                    </h4>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs",
                        STRENGTH_STYLES[p.strength] ?? STRENGTH_STYLES["emerging"],
                      )}
                    >
                      {p.strength}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {fb?.verdict === "edited" && fb.detail ? fb.detail : p.detail}
                  </p>
                  {p.suggestedAction ? (
                    <p className="mt-1.5 text-sm">Next step: {p.suggestedAction}</p>
                  ) : null}
                  <Citations citations={p.citations} />
                  {p.caseCodes?.length ? (
                    <p className="metric-value mt-1.5 text-xs text-muted-foreground">
                      Seen in {p.caseCodes.join(", ")}
                    </p>
                  ) : null}
                  <PatternVerdictControls pattern={p} feedback={fb} onChange={updateVerdict} />
                </article>
                );
              })}
            </div>
          ) : null}

          {result.perCase.length ? (
            <div className="space-y-2">
              <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
                Key details drawn from each note
              </h3>
              {result.perCase.map((c) => (
                <article
                  key={c.sessionId || c.caseCode}
                  className="rounded-md bg-muted/30 px-3 py-2.5"
                >
                  <h4 className="metric-value text-sm font-medium">{c.caseCode}</h4>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {c.keyDetails?.map((d) => (
                      <span
                        key={d}
                        className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {d}
                      </span>
                    ))}
                    {c.riskFactors?.map((d) => (
                      <span
                        key={d}
                        className="rounded-full border border-critical/40 bg-critical/10 px-2 py-0.5 text-xs text-critical"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                  {c.eegCorrelation ? (
                    <p className="mt-1.5 text-sm text-muted-foreground">{c.eegCorrelation}</p>
                  ) : null}
                  <Citations citations={c.citations} />
                </article>
              ))}
            </div>
          ) : null}

          {result.recordingGaps.length ? (
            <div>
              <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
                Worth recording next time
              </h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {result.recordingGaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.limitations.length ? (
            <p className="text-xs text-muted-foreground">
              Hypotheses only, from your own uncontrolled frontal-montage dataset —{" "}
              {result.limitations.join(" ")}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Write a case summary when you file a case; once two or more cases have notes, the AI can
          compare them.
        </p>
      )}
    </section>
  );
}
