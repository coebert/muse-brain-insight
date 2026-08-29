import { AlertTriangle, Activity, HeartPulse } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  ACUTE_PATHOLOGY,
  CHRONIC_CONDITIONS,
  NONE_KEY,
  clinicalLevelLabel,
  deriveClinicalCovariates,
  toggleCondition,
  validateClinicalCovariates,
  type ConditionOption,
} from "@/lib/eeg/clinical-covariates";

/**
 * Structured, validated chronic-condition and acute-pathology entry.
 *
 * These are model inputs, not notes: the vocabulary is closed, "None" is
 * mutually exclusive with everything else, and the derived levels the depth
 * model will actually see are shown back to the clinician so it is obvious
 * what the entry changes.
 */
export function ClinicalCovariateFields({
  chronicConditions,
  acutePathology,
  onChange,
}: {
  chronicConditions: string[];
  acutePathology: string[];
  onChange: (next: { chronicConditions: string[]; acutePathology: string[] }) => void;
}) {
  const validation = validateClinicalCovariates({ chronicConditions, acutePathology });
  const derived = deriveClinicalCovariates(validation.value);

  return (
    <div className="space-y-3">
      <ConditionPicker
        title="Chronic conditions"
        icon={<HeartPulse className="size-3.5 text-signal" />}
        hint="Long-standing disease that changes the resting EEG or drug handling."
        options={CHRONIC_CONDITIONS}
        selected={chronicConditions}
        errors={validation.errors.chronicConditions}
        onToggle={(key) =>
          onChange({
            chronicConditions: toggleCondition(chronicConditions, key),
            acutePathology,
          })
        }
      />
      <ConditionPicker
        title="Acute pathology"
        icon={<Activity className="size-3.5 text-signal" />}
        hint="The acute illness or injury being treated during this recording."
        options={ACUTE_PATHOLOGY}
        selected={acutePathology}
        errors={validation.errors.acutePathology}
        onToggle={(key) =>
          onChange({
            chronicConditions,
            acutePathology: toggleCondition(acutePathology, key),
          })
        }
      />
      <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Model covariates from this entry: </span>
        {derived.chronicBurden || derived.acuteClass ? (
          [
            derived.chronicBurden ? clinicalLevelLabel("chronic", derived.chronicBurden) : null,
            derived.chronicCns === "present"
              ? clinicalLevelLabel("chronic_cns", derived.chronicCns)
              : null,
            derived.acuteClass ? clinicalLevelLabel("acute", derived.acuteClass) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        ) : (
          <>nothing yet — depth stays calibrated on age, sex and regimen alone.</>
        )}
      </div>
    </div>
  );
}

function ConditionPicker({
  title,
  hint,
  icon,
  options,
  selected,
  errors,
  onToggle,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  options: ConditionOption[];
  selected: string[];
  errors: string[];
  onToggle: (key: string) => void;
}) {
  const noneOn = selected.includes(NONE_KEY);
  return (
    <div>
      <Label className="flex items-center gap-1.5">
        {icon}
        {title}
      </Label>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Chip label="None" on={noneOn} onClick={() => onToggle(NONE_KEY)} />
        {options.map((o) => (
          <Chip
            key={o.key}
            label={o.label}
            title={o.eegRelevance}
            on={selected.includes(o.key)}
            dimmed={noneOn}
            onClick={() => onToggle(o.key)}
          />
        ))}
      </div>
      {errors.length ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-critical">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

function Chip({
  label,
  title,
  on,
  dimmed,
  onClick,
}: {
  label: string;
  title?: string;
  on: boolean;
  dimmed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        "min-h-8 rounded-full border px-2.5 py-1 text-xs transition-colors",
        on
          ? "border-signal bg-signal/15 text-signal"
          : "border-border text-muted-foreground hover:text-foreground",
        dimmed && !on && "opacity-40",
      )}
    >
      {label}
    </button>
  );
}
