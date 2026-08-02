import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2, MessageSquare, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  submitAlertFeedback,
  type AlertVerdict,
} from "@/lib/eeg/alert-feedback.functions";
import type { ClinicalAlert } from "@/lib/eeg/interpret.functions";

const INCORRECT_REASONS = [
  "Artefact, not a true EEG change",
  "Expected for this drug/technique",
  "Wrong severity",
  "Clinically inappropriate action",
  "Already addressed at the bedside",
];

interface Props {
  alert: ClinicalAlert;
  sessionId?: string | null;
  /** Free-text context, e.g. "general_anaesthesia" or "icu". */
  context?: string | null;
}

export function AlertFeedback({ alert, sessionId, context }: Props) {
  const submit = useServerFn(submitAlertFeedback);
  const [verdict, setVerdict] = useState<AlertVerdict | null>(null);
  const [pendingVerdict, setPendingVerdict] = useState<AlertVerdict | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function send(next: AlertVerdict, withReason: string) {
    setSaving(true);
    try {
      await submit({
        data: {
          alertId: alert.id || alert.title,
          category: alert.category,
          severity: alert.severity,
          title: alert.title,
          verdict: next,
          reason: withReason || null,
          sessionId: sessionId ?? null,
          context: context ?? null,
        },
      });
      setVerdict(next);
      setPendingVerdict(null);
      setSaved(true);
      toast.success(
        next === "correct"
          ? "Marked correct — the reviewer will keep flagging this."
          : "Thanks — the reviewer will weigh this alert more cautiously.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save your feedback.");
    } finally {
      setSaving(false);
    }
  }

  if (saved && !pendingVerdict) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Check className="h-3 w-3" aria-hidden />
        Marked {verdict === "correct" ? "correct" : verdict === "incorrect" ? "incorrect" : "unsure"}
        {reason ? ` · ${reason}` : ""}
      </p>
    );
  }

  return (
    <div className="mt-2 border-t border-current/15 pt-2">
      {!pendingVerdict ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Was this alert right?</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={saving}
            onClick={() => setPendingVerdict("correct")}
          >
            <ThumbsUp className="h-3 w-3" /> Correct
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={saving}
            onClick={() => setPendingVerdict("incorrect")}
          >
            <ThumbsDown className="h-3 w-3" /> Incorrect
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            disabled={saving}
            onClick={() => setPendingVerdict("unsure")}
          >
            Unsure
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <MessageSquare className="h-3 w-3 shrink-0" aria-hidden />
            <span className="text-[11px] font-medium">
              Marking {pendingVerdict} — why? (optional)
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 w-6 p-0"
              onClick={() => setPendingVerdict(null)}
              aria-label="Cancel feedback"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          {pendingVerdict === "incorrect" ? (
            <div className="flex flex-wrap gap-1.5">
              {INCORRECT_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${
                    reason === r ? "border-transparent bg-foreground/15 font-medium" : "border-border"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          ) : null}
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 1000))}
            rows={2}
            placeholder="What did the reviewer get wrong or right, and what did you see clinically?"
            className="text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              className="h-7 px-3 text-[11px]"
              disabled={saving}
              onClick={() => void send(pendingVerdict, reason.trim())}
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save feedback
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}