import { AlertTriangle, EyeOff, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
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
  KETAMINE_FLAG_OPTIONS,
  SEX_OPTIONS,
  type CaseMeta,
} from "@/lib/eeg/case-meta";

import { scrubCaseText, summariseFindings } from "@/lib/eeg/deid";
import { FRAILTY_LEVELS, REGIMENS } from "@/lib/eeg/covariates";
import { Button } from "@/components/ui/button";
import { generateCaseCode } from "@/lib/eeg/case-startup";
import { generateUniqueCaseCode, isCaseCodeUsed } from "@/lib/eeg/case-code-registry";
import { cn } from "@/lib/utils";
import { ClinicalCovariateFields } from "@/components/monitor/ClinicalCovariateFields";

/**
 * Shared anonymised case fields, used both when opening a case and when
 * amending details before filing it.
 */
export function CaseFields({
  meta,
  onChange,
  idPrefix = "case",
  usedCaseCodes = [],
}: {
  meta: CaseMeta;
  onChange: (next: CaseMeta) => void;
  idPrefix?: string;
  /** Codes already filed on this device — used to block duplicates. */
  usedCaseCodes?: string[];
}) {
  const duplicate = isCaseCodeUsed(meta.caseCode, usedCaseCodes);
  // Live preview of what automatic de-identification will strip on filing.
  const scrub = scrubCaseText({
    location: meta.location || null,
    notes: meta.notes || null,
    admissionDiagnosis: meta.admissionDiagnosis || null,
    caseSummary: meta.caseSummary || null,
  });

  function reroll() {
    const result = generateUniqueCaseCode(usedCaseCodes, () => generateCaseCode(meta.context));
    onChange({ ...meta, caseCode: result.code });
    if (!result.unique) {
      toast.warning("Could not mint a unique code — edit it before filing the case.");
    } else if (result.collisions > 0) {
      toast.warning(
        `That code was already used on this device — generated ${result.code} instead.`,
      );
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${idPrefix}-code`}>Anonymised case code</Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={reroll}
          >
            <RefreshCw className="size-3.5" /> New code
          </Button>
        </div>
        <Input
          id={`${idPrefix}-code`}
          className={cn("mt-1.5", duplicate && "border-critical focus-visible:ring-critical")}
          aria-invalid={duplicate}
          placeholder="e.g. GA-260806-K7QF"
          value={meta.caseCode}
          onChange={(e) => onChange({ ...meta, caseCode: e.target.value })}
        />
        {duplicate ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-critical">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            This code is already used by a case in your archive. Change it or press “New code” —
            duplicates cannot be filed.
          </p>
        ) : null}
        <p className="mt-1 text-[11px] text-muted-foreground">
          Generated automatically and contains no patient identifiers — overwrite it if your unit
          uses its own numbering.
        </p>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-pid`}>Hospital identifier (for secure linkage)</Label>
        <Input
          id={`${idPrefix}-pid`}
          className="mt-1.5"
          autoComplete="off"
          placeholder="e.g. RXH1234567 — optional"
          value={meta.patientIdentifier}
          onChange={(e) => onChange({ ...meta, patientIdentifier: e.target.value })}
        />
        <p className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-px size-3.5 shrink-0 text-signal" />
          Never stored with the recording. It is encrypted into a private linkage record and the
          case keeps only a pseudonym, so the same patient’s recordings group together while the
          record itself stays anonymous. Leave blank for a fully unlinked case.
        </p>
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
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Anaesthetic / sedation regimen</Label>
          <Select value={meta.regimen} onValueChange={(v) => onChange({ ...meta, regimen: v })}>
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {REGIMENS.map((r) => (
                <SelectItem key={r.key} value={r.key}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">
            The EEG signature of a given depth differs by agent — recording this lets COEBIS learn a
            regimen-specific correction.
          </p>
        </div>
        <div>
          <Label>Frailty</Label>
          <Select value={meta.frailty} onValueChange={(v) => onChange({ ...meta, frailty: v })}>
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {FRAILTY_LEVELS.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="rounded-md border border-border/70 p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Ketamine</Label>
            <Select
              value={meta.ketamineGiven || "unrecorded"}
              onValueChange={(v) =>
                onChange({ ...meta, ketamineGiven: v === "unrecorded" ? "" : v })
              }
            >
              <SelectTrigger className="mt-1.5 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KETAMINE_FLAG_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor={`${idPrefix}-ket-detail`}>Ketamine detail</Label>
            <Input
              id={`${idPrefix}-ket-detail`}
              className="mt-1.5"
              placeholder="e.g. 0.3 mg/kg bolus at induction"
              value={meta.ketamineDetail}
              disabled={meta.ketamineGiven !== "yes"}
              onChange={(e) => onChange({ ...meta, ketamineDetail: e.target.value })}
            />
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Answering here is what licenses the ketamine correction on this case. “No ketamine” rules
          it out even if a note mentions the drug; leaving it unrecorded falls back to reading the
          regimen and notes, which only ever raises an advisory.
        </p>
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
      <ClinicalCovariateFields
        chronicConditions={meta.chronicConditions}
        acutePathology={meta.acutePathology}
        onChange={(next) => onChange({ ...meta, ...next })}
      />
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
      <div>
        <Label htmlFor={`${idPrefix}-summary`}>Case summary (free text)</Label>
        <Textarea
          id={`${idPrefix}-summary`}
          className="mt-1.5 min-h-32"
          placeholder="Write the case in your own words: what was done, how the patient behaved, anything unusual — e.g. “Frail 84-year-old, emergency laparotomy for perforated diverticulum. Deep suppression at low propofol Ce, slow to wake, delirious in recovery.”"
          value={meta.caseSummary}
          onChange={(e) => onChange({ ...meta, caseSummary: e.target.value })}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Kept encrypted and read by the AI, which extracts key details and looks for patterns
          across your cases. Never include names, dates of birth or hospital numbers.
        </p>
      </div>
      {scrub.findings.length ? (
        <p className="flex items-start gap-1.5 rounded-md border border-caution/40 bg-caution/10 px-2.5 py-2 text-[11px] text-caution">
          <EyeOff className="mt-px size-3.5 shrink-0" />
          <span>
            Automatic de-identification will clean this case before it is filed.{" "}
            {summariseFindings(scrub.findings)}
          </span>
        </p>
      ) : null}
    </div>
  );
}
