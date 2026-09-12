import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { formatRangeInZone } from "@/lib/eeg/timezone";
import { sealTexts } from "@/lib/privacy.functions";

/**
 * Case notes for a filed case. The note is always shown against the recorded
 * start/end times of that case so it can never be read out of context.
 *
 * The second box is the free-text case story the AI reads when it mines cases
 * for patterns, so it can be written or corrected long after the case.
 */
export function CaseNotes({
  sessionId,
  notes,
  caseSummary,
  startedAt,
  endedAt,
  zone,
  onSaved,
}: {
  sessionId: string;
  notes: string | null;
  caseSummary?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  zone: string;
  onSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [summaryDraft, setSummaryDraft] = useState(caseSummary ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraft(notes ?? "");
      setSummaryDraft(caseSummary ?? "");
    }
  }, [notes, caseSummary, editing]);

  async function save() {
    setSaving(true);
    try {
      const text = draft.trim();
      const summary = summaryDraft.trim();
      const { values } = await sealTexts({ data: { values: [text || null, summary || null] } });
      const sealed = values as (string | null)[];
      const { error } = await supabase
        .from("eeg_sessions")
        .update({ notes: sealed[0] ?? null, case_summary: sealed[1] ?? null })
        .eq("id", sessionId);
      if (error) throw error;
      setEditing(false);
      toast.success("Case notes saved");
      onSaved?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the case notes");
    } finally {
      setSaving(false);
    }
  }

  const timing = formatRangeInZone(startedAt, endedAt, zone);

  return (
    <section className="mt-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-xs font-medium tracking-wide uppercase">Case notes</h3>
        <span className="metric-value text-xs text-muted-foreground">{timing}</span>
        {!editing ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto min-h-9 px-2 text-xs"
            onClick={() => setEditing(true)}
          >
            {notes || caseSummary ? "Edit" : "Add notes"}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-2 space-y-3">
          <Textarea
            aria-label="Case notes"
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Anonymised notes for this case — course, interventions, EEG findings…"
          />
          <div>
            <label
              htmlFor={`summary-${sessionId}`}
              className="text-xs font-medium tracking-wide uppercase"
            >
              Case story for the AI
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Anonymised background and how the case ran. This is the text the AI reads when it
              looks for patterns across cases. No names, dates of birth or record numbers.
            </p>
            <Textarea
              id={`summary-${sessionId}`}
              className="mt-1.5"
              rows={5}
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              placeholder="Frail patient for emergency laparotomy, septic on arrival, propofol TCI with low targets, deep periods after induction…"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="min-h-9" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save notes"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="min-h-9"
              disabled={saving}
              onClick={() => {
                setDraft(notes ?? "");
                setSummaryDraft(caseSummary ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-1.5 text-sm whitespace-pre-wrap text-muted-foreground">
            {notes?.trim() ? notes : "No notes recorded for this case yet."}
          </p>
          <p className="mt-2 text-xs font-medium tracking-wide uppercase">Case story for the AI</p>
          <p className="mt-0.5 text-sm whitespace-pre-wrap text-muted-foreground">
            {caseSummary?.trim()
              ? caseSummary
              : "Nothing written yet — add the anonymised story so the AI can learn from this case."}
          </p>
        </>
      )}
    </section>
  );
}
