import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  CLINICAL_FEATURES,
  CONTEXTS,
  SEX_OPTIONS,
  type CaseMeta,
} from "@/lib/eeg/case-meta";
import { cn } from "@/lib/utils";

/**
 * Shared anonymised case fields, used both when opening a case and when
 * amending details before filing it.
 */
export function CaseFields({
  meta,
  onChange,
  idPrefix = "case",
}: {
  meta: CaseMeta;
  onChange: (next: CaseMeta) => void;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor={`${idPrefix}-code`}>Anonymised case code</Label>
        <Input
          id={`${idPrefix}-code`}
          className="mt-1.5"
          placeholder="e.g. GA-2026-014"
          value={meta.caseCode}
          onChange={(e) => onChange({ ...meta, caseCode: e.target.value })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Context</Label>
          <Select value={meta.context} onValueChange={(v) => onChange({ ...meta, context: v })}>
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTEXTS.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-loc`}>Location</Label>
          <Input
            id={`${idPrefix}-loc`}
            className="mt-1.5"
            placeholder="Theatre 4 / ICU bed 7"
            value={meta.location}
            onChange={(e) => onChange({ ...meta, location: e.target.value })}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${idPrefix}-age`}>Age (years)</Label>
          <Input
            id={`${idPrefix}-age`}
            type="number"
            min={0}
            max={120}
            className="mt-1.5"
            placeholder="e.g. 68"
            value={meta.ageYears}
            onChange={(e) => onChange({ ...meta, ageYears: e.target.value })}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Ages of 90 and over are stored as a “90+” band only.
          </p>
        </div>
        <div>
          <Label>Sex</Label>
          <Select value={meta.sex} onValueChange={(v) => onChange({ ...meta, sex: v })}>
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {SEX_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-dx`}>Admission diagnosis</Label>
        <Input
          id={`${idPrefix}-dx`}
          className="mt-1.5"
          placeholder="e.g. community-acquired pneumonia"
          value={meta.admissionDiagnosis}
          onChange={(e) => onChange({ ...meta, admissionDiagnosis: e.target.value })}
        />
      </div>
      <div>
        <Label>Admission / clinical features</Label>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CLINICAL_FEATURES.map((f) => {
            const on = meta.clinicalFeatures.includes(f);
            return (
              <button
                key={f}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange({
                    ...meta,
                    clinicalFeatures: on
                      ? meta.clinicalFeatures.filter((x) => x !== f)
                      : [...meta.clinicalFeatures, f],
                  })
                }
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  on
                    ? "border-signal bg-signal/15 text-signal"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {f}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          className="mt-1.5"
          placeholder="Agent, infusion rates, clinical events…"
          value={meta.notes}
          onChange={(e) => onChange({ ...meta, notes: e.target.value })}
        />
      </div>
    </div>
  );
}