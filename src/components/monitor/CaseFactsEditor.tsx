import { useServerFn } from "@tanstack/react-start";
import { Check, ListChecks, Plus, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EMERGENCE_OPTIONS,
  FACT_LIST_FIELDS,
  URGENCY_OPTIONS,
  factsAreEmpty,
  type CaseFacts,
  type CaseFactsRecord,
} from "@/lib/eeg/case-facts";
import { loadCaseFacts, proposeCaseFacts, saveCaseFacts } from "@/lib/eeg/case-facts.functions";
import { cn } from "@/lib/utils";

/** Chip list with add/remove, used for every list-shaped field. */
function ListField({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  }

  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
          >
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="text-muted-foreground hover:text-critical"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {!values.length ? (
          <span className="text-xs text-muted-foreground">Nothing recorded</span>
        ) : null}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={`Add to ${label.toLowerCase()}`}
          className="h-9 text-sm"
        />
        <Button type="button" variant="outline" size="sm" className="h-9" onClick={add}>
          <Plus className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function CaseCard({
  record,
  onChange,
  onSave,
  saving,
}: {
  record: CaseFactsRecord;
  onChange: (facts: CaseFacts) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { facts } = record;
  const set = (patch: Partial<CaseFacts>) => onChange({ ...facts, ...patch });

  return (
    <article className="rounded-md border border-border px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 className="metric-value text-sm font-medium">{record.caseCode}</h4>
          <p className="text-xs text-muted-foreground">
            {new Date(record.recordedAt).toLocaleDateString()}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs",
            record.confirmed && !record.draft
              ? "bg-signal/15 text-signal"
              : record.draft
                ? "bg-caution/15 text-caution"
                : "bg-muted text-muted-foreground",
          )}
        >
          {record.confirmed && !record.draft
            ? "Confirmed"
            : record.draft
              ? "AI draft — check me"
              : "Not confirmed"}
        </span>
      </div>

      {record.summaryExcerpt ? (
        <p className="mt-2 rounded bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
          {record.summaryExcerpt}
        </p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="text-xs text-muted-foreground">Procedure / reason</Label>
          <Input
            className="mt-1.5 h-9 text-sm"
            value={facts.procedure}
            placeholder="e.g. emergency laparotomy"
            onChange={(e) => set({ procedure: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-muted-foreground">Urgency</Label>
            <Select
              value={facts.urgency}
              onValueChange={(v) => set({ urgency: v as CaseFacts["urgency"] })}
            >
              <SelectTrigger className="mt-1.5 h-9 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {URGENCY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Emergence</Label>
            <Select
              value={facts.emergence}
              onValueChange={(v) => set({ emergence: v as CaseFacts["emergence"] })}
            >
              <SelectTrigger className="mt-1.5 h-9 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMERGENCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {FACT_LIST_FIELDS.map((f) => (
          <ListField
            key={f.key}
            label={f.label}
            values={facts[f.key] as string[]}
            onChange={(next) => set({ [f.key]: next } as Partial<CaseFacts>)}
          />
        ))}
      </div>

      <div className="mt-3 flex justify-end">
        <Button size="sm" className="min-h-9" disabled={saving} onClick={onSave}>
          <Check className="size-4" />
          {saving
            ? "Saving…"
            : record.confirmed && !record.draft
              ? "Save changes"
              : "Confirm details"}
        </Button>
      </div>
    </article>
  );
}

/**
 * Review step before pattern mining: the AI proposes normalised fields from
 * each free-text case summary and the clinician corrects and confirms them.
 */
export function CaseFactsEditor({
  onConfirmedChange,
}: {
  onConfirmedChange?: (n: number) => void;
}) {
  const load = useServerFn(loadCaseFacts);
  const propose = useServerFn(proposeCaseFacts);
  const save = useServerFn(saveCaseFacts);

  const [records, setRecords] = useState<CaseFactsRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await load({ data: { limit: 25 } });
      setRecords(next);
      onConfirmedChange?.(next.filter((r) => r.confirmed).length);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load your case details.");
    } finally {
      setLoading(false);
    }
  }, [load, onConfirmedChange]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function extract() {
    if (!records?.length) return;
    // Only cases with nothing recorded yet — never overwrite confirmed edits.
    const targets = records.filter((r) => !r.confirmed && factsAreEmpty(r.facts));
    if (!targets.length) {
      toast.info("Every written case already has details — edit them below.");
      return;
    }
    setExtracting(true);
    try {
      const drafts = await propose({ data: { sessionIds: targets.map((t) => t.sessionId) } });
      const byId = new Map(drafts.map((d) => [d.sessionId, d.facts]));
      setRecords((prev) =>
        (prev ?? []).map((r) =>
          byId.has(r.sessionId) ? { ...r, facts: byId.get(r.sessionId)!, draft: true } : r,
        ),
      );
      toast.success(
        `Extracted details for ${drafts.length} case${drafts.length === 1 ? "" : "s"} — check and confirm them.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not extract details.");
    } finally {
      setExtracting(false);
    }
  }

  async function confirm(record: CaseFactsRecord) {
    setSavingId(record.sessionId);
    try {
      await save({ data: { sessionId: record.sessionId, facts: record.facts, confirmed: true } });
      setRecords((prev) => {
        const next = (prev ?? []).map((r) =>
          r.sessionId === record.sessionId ? { ...r, confirmed: true, draft: false } : r,
        );
        onConfirmedChange?.(next.filter((r) => r.confirmed).length);
        return next;
      });
      toast.success(`${record.caseCode} details confirmed.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save these details.");
    } finally {
      setSavingId(null);
    }
  }

  const confirmedCount = records?.filter((r) => r.confirmed).length ?? 0;

  return (
    <section className="panel px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ListChecks className="size-4 text-signal" /> Structured details from your summaries
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The AI normalises each written case summary into fixed fields. Check and correct them
            here — confirmed fields are what the pattern search compares across cases.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={extract}
          disabled={extracting || loading || !records?.length}
          className="min-h-11 sm:min-h-9"
        >
          <Sparkles className="size-4" />
          {extracting ? "Reading summaries…" : "Extract details"}
        </Button>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading your written cases…</p>
      ) : !records?.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No written case summaries yet — add one when you file a case and its details will appear
          here for review.
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs text-muted-foreground">
            {confirmedCount} of {records.length} written case{records.length === 1 ? "" : "s"}{" "}
            confirmed.
          </p>
          <div className="mt-3 space-y-3">
            {records.map((r) => (
              <CaseCard
                key={r.sessionId}
                record={r}
                saving={savingId === r.sessionId}
                onChange={(facts) =>
                  setRecords((prev) =>
                    (prev ?? []).map((x) => (x.sessionId === r.sessionId ? { ...x, facts } : x)),
                  )
                }
                onSave={() => void confirm(r)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
