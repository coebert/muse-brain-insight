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
 */
export function CaseNotes({
  sessionId,
  notes,
  startedAt,
  endedAt,
  zone,
  onSaved,
}: {
  sessionId: string;
  notes: string | null;
  startedAt: string | null;
  endedAt: string | null;
  zone: string;
  onSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(notes ?? "");
  }, [notes, editing]);

  async function save() {
    setSaving(true);
    try {
      const text = draft.trim();
      const { values } = await sealTexts({ data: { values: [text || null] } });
      const { error } = await supabase
        .from("eeg_sessions")
        .update({ notes: (values as (string | null)[])[0] ?? null })
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
            {notes ? "Edit" : "Add notes"}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            aria-label="Case notes"
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Anonymised notes for this case — course, interventions, EEG findings…"
          />
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
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 text-sm whitespace-pre-wrap text-muted-foreground">
          {notes?.trim() ? notes : "No notes recorded for this case yet."}
        </p>
      )}
    </section>
  );
}
