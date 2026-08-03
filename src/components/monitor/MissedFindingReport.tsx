import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { EyeOff, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { submitAlertFeedback } from "@/lib/eeg/alert-feedback.functions";

const CATEGORIES = [
  { value: "excessive_depth", label: "Excessive depth" },
  { value: "inadequate_depth", label: "Inadequate depth" },
  { value: "burst_suppression", label: "Burst suppression" },
  { value: "seizure", label: "Seizure / ictal" },
  { value: "hypoxic_injury", label: "Hypoxic injury" },
  { value: "encephalopathy", label: "Encephalopathy" },
  { value: "nociception", label: "Nociception" },
  { value: "signal_quality", label: "Signal quality" },
  { value: "other", label: "Other" },
];

interface Props {
  sessionId?: string | null;
  context?: string | null;
  modelVersion?: string | null;
}

/** Logs a finding the AI never raised, so recall can be measured. */
export function MissedFindingReport({ sessionId, context, modelVersion }: Props) {
  const submit = useServerFn(submitAlertFeedback);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("seizure");
  const [severity, setSeverity] = useState("warning");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    if (!title.trim()) {
      toast.error("Describe the finding the reviewer missed.");
      return;
    }
    setSaving(true);
    try {
      await submit({
        data: {
          alertId: `missed-${Date.now()}`,
          category,
          severity,
          title: title.trim(),
          verdict: "missed",
          reason: note.trim() || null,
          sessionId: sessionId ?? null,
          context: context ?? null,
          modelVersion: modelVersion ?? null,
          alertConfidence: null,
        },
      });
      setSaved(true);
      setOpen(false);
      setTitle("");
      setNote("");
      toast.success("Missed finding logged — it now counts against recall.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not log the missed finding.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
          <EyeOff className="h-3 w-3" /> Report a finding the reviewer missed
        </Button>
        {saved ? (
          <span className="text-xs text-muted-foreground">Logged — visible in model performance.</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <EyeOff className="h-3.5 w-3.5" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Missed finding
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 w-6 p-0"
          onClick={() => setOpen(false)}
          aria-label="Cancel missed finding"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value.slice(0, 200))}
        placeholder="What did you see that the reviewer did not raise?"
        className="h-8 text-xs"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="warning">Warning</SelectItem>
            <SelectItem value="advisory">Advisory</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 1000))}
        rows={2}
        placeholder="Clinical context (optional)"
        className="text-xs"
      />
      <div className="flex justify-end">
        <Button size="sm" className="h-7 px-3 text-xs" disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Log missed finding
        </Button>
      </div>
    </div>
  );
}
