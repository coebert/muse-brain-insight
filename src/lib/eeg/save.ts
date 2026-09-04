import { ketamineFlagValue } from "./case-meta";
import { supabase } from "@/integrations/supabase/client";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";
import { sealTexts } from "@/lib/privacy.functions";
import { scrubCaseText, type DeidFinding } from "@/lib/eeg/deid";
import {
  deriveClinicalCovariates,
  validateClinicalCovariates,
} from "@/lib/eeg/clinical-covariates";
import { linkPatient } from "@/lib/eeg/patient-link.functions";
import { clearStagedSave, isTransient, stageSave, withRetry } from "@/lib/eeg/save-staging";
import {
  EPOCH_BATCH_SIZE,
  buildManifest,
  epochPayload,
  eventPayload,
  type SessionManifest,
} from "@/lib/eeg/batch-integrity";

/**
 * Checksums for the most recent save, so the reload path can prove the stored
 * spectral arrays and events came back byte-identical.
 */
let lastSaveManifests: { epochs: SessionManifest; events: SessionManifest | null } | null = null;

export function getLastSaveManifests() {
  return lastSaveManifests;
}

export interface SessionMeta {
  caseCode: string;
  context: string;
  /** Hospital identifier, converted to a sealed link and never stored raw. */
  patientIdentifier: string;
  location: string;
  notes: string;
  /** Free-text clinical summary written by the clinician. */
  caseSummary: string;
  deviceName: string;
  /** Age in whole years; ages ≥ 90 are stored as a band only. */
  ageYears: string;
  sex: string;
  admissionDiagnosis: string;
  clinicalFeatures: string[];
  /** Structured chronic conditions, validated against a closed vocabulary. */
  chronicConditions: string[];
  /** Structured acute pathology, validated against a closed vocabulary. */
  acutePathology: string[];
  /** Anaesthetic / sedation regimen (covariate for COEBIS). */
  regimen: string;
  /** Frailty grouping (covariate for COEBIS). */
  frailty: string;
  /** Filed ketamine flag: "yes", "no", or "" when not recorded. */
  ketamineGiven?: string;
  /** Optional detail about the ketamine exposure. */
  ketamineDetail?: string;
}

/** Coarse banding keeps records non-identifying even when age is recorded. */
export function ageBand(age: number | null): string | null {
  if (age === null || Number.isNaN(age)) return null;
  if (age < 18) return "<18";
  if (age < 40) return "18-39";
  if (age < 60) return "40-59";
  if (age < 75) return "60-74";
  if (age < 90) return "75-89";
  return "90+";
}

/** Store at most this many epochs per session; older data is decimated evenly. */
const MAX_STORED_EPOCHS = 900;

function decimate(epochs: Epoch[]): Epoch[] {
  if (epochs.length <= MAX_STORED_EPOCHS) return epochs;
  const step = epochs.length / MAX_STORED_EPOCHS;
  const out: Epoch[] = [];
  for (let i = 0; i < MAX_STORED_EPOCHS; i++) out.push(epochs[Math.floor(i * step)]!);
  return out;
}

/**
 * Run one database write, turning a PostgREST error into a thrown error so the
 * retry policy can see it, and retrying transient failures with backoff.
 */
async function write<T>(
  op: () => PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  return withRetry(
    async () => {
      const { data, error } = await op();
      if (error) throw new Error(error.message);
      return data;
    },
    { shouldRetry: isTransient },
  );
}

export async function saveSession(
  meta: SessionMeta,
  epochs: Epoch[],
  events: DetectedEvent[],
  summary: { meanSr: number; maxSr: number; suppressionSeconds: number; seizureAlerts: number },
  elapsed: number,
  /** Wall-clock time the case actually started, in ms since epoch. */
  startedAtMs?: number,
) {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("You need to be signed in to save a session.");

  // Stage the case locally first so a dropped connection mid-save cannot lose
  // a completed record.
  stageSave(meta.caseCode, { meta, summary, elapsed, events: events.length });

  // Free-text fields are encrypted (AES-256-GCM) before they leave the browser session.
  // Everything is de-identified first, so nothing readable can survive even if
  // an identifier was typed into a note by accident.
  const scrub = scrubCaseText({
    caseCode: meta.caseCode,
    location: meta.location || null,
    notes: meta.notes || null,
    admissionDiagnosis: meta.admissionDiagnosis.trim() || null,
    caseSummary: meta.caseSummary.trim() || null,
  });
  const deidFindings: DeidFinding[] = scrub.findings;

  // Structured covariates are validated before they are stored, so the model
  // never learns a level that came from a typo or a stale vocabulary.
  const validated = validateClinicalCovariates({
    chronicConditions: meta.chronicConditions ?? [],
    acutePathology: meta.acutePathology ?? [],
  });
  if (!validated.ok) {
    const messages = [...validated.errors.chronicConditions, ...validated.errors.acutePathology];
    throw new Error(`Clinical details could not be filed: ${messages.join(" ")}`);
  }
  const validatedClinical = validated.value;
  const derivedClinical = deriveClinicalCovariates(validatedClinical);

  // Secure linkage: the identifier becomes a pseudonym held in a sealed table.
  let patientLinkId: string | null = null;
  let patientPseudonym: string | null = null;
  if (meta.patientIdentifier.trim()) {
    const link = await linkPatient({ data: { identifier: meta.patientIdentifier.trim() } });
    patientLinkId = link.id;
    patientPseudonym = link.pseudonym;
  }

  const { values: sealed } = await sealTexts({
    data: {
      values: [
        scrub.fields.caseCode,
        scrub.fields.location,
        scrub.fields.notes,
        scrub.fields.admissionDiagnosis,
        scrub.fields.caseSummary,
      ],
    },
  });
  const [sealedCase, sealedLocation, sealedNotes, sealedDiagnosis, sealedSummary] =
    sealed as (string | null)[];

  // Record when the case actually ran, not when it happened to be filed.
  const startedAt = new Date(
    startedAtMs && Number.isFinite(startedAtMs) ? startedAtMs : Date.now() - elapsed * 1000,
  );
  const endedAt = new Date(startedAt.getTime() + Math.max(0, elapsed) * 1000);

  const session = await write(() =>
    supabase
      .from("eeg_sessions")
      .insert({
        user_id: userId,
        case_code: sealedCase ?? meta.caseCode,
        patient_link_id: patientLinkId,
        patient_pseudonym: patientPseudonym,
        deid_findings: deidFindings.map((f) => ({ kind: f.kind, count: f.count })),
        context: meta.context,
        location: sealedLocation ?? null,
        notes: sealedNotes ?? null,
        case_summary: sealedSummary ?? null,
        device_name: meta.deviceName || null,
        age_years: (() => {
          const n = meta.ageYears.trim() === "" ? null : Number(meta.ageYears);
          if (n === null || Number.isNaN(n)) return null;
          // Never store an exact age of 90+, which can be identifying.
          return n >= 90 ? null : Math.round(n);
        })(),
        age_band: ageBand(meta.ageYears.trim() === "" ? null : Number(meta.ageYears)),
        sex: meta.sex || null,
        regimen: meta.regimen || null,
        frailty: meta.frailty || null,
        ketamine_given: ketamineFlagValue(meta.ketamineGiven ?? ""),
        ketamine_detail:
          (meta.ketamineGiven ?? "") === "yes" ? meta.ketamineDetail?.trim() || null : null,
        admission_diagnosis: sealedDiagnosis ?? null,
        clinical_features: meta.clinicalFeatures,
        chronic_conditions: validatedClinical.chronicConditions,
        acute_pathology: validatedClinical.acutePathology,
        chronic_burden: derivedClinical.chronicBurden,
        chronic_cns: derivedClinical.chronicCns,
        acute_class: derivedClinical.acuteClass,
        duration_seconds: Math.round(elapsed),
        mean_suppression_ratio: Number(summary.meanSr.toFixed(2)),
        max_suppression_ratio: Number(summary.maxSr.toFixed(2)),
        suppression_seconds: Number(summary.suppressionSeconds.toFixed(1)),
        seizure_alerts: summary.seizureAlerts,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
      })
      .select("id")
      .single(),
  );
  if (!session) throw new Error("The case was not saved — no record was returned.");

  // Serialisation lives in batch-integrity so the checksums recorded for this
  // save are taken over exactly the values that are inserted.
  const rows = decimate(epochs).map((e) => ({
    session_id: session.id,
    user_id: userId,
    ...epochPayload(e),
  }));
  const epochManifest = buildManifest("epochs", rows, EPOCH_BATCH_SIZE);
  for (let i = 0; i < rows.length; i += EPOCH_BATCH_SIZE) {
    const chunk = rows.slice(i, i + EPOCH_BATCH_SIZE);
    await write(() => supabase.from("eeg_epochs").insert(chunk));
  }

  let eventManifest: SessionManifest | null = null;
  if (events.length) {
    const eventRows = events.map((ev) => ({
      session_id: session.id,
      user_id: userId,
      ...eventPayload(ev),
    }));
    eventManifest = buildManifest("events", eventRows, EPOCH_BATCH_SIZE);
    await write(() => supabase.from("eeg_events").insert(eventRows));
  }

  clearStagedSave();
  lastSaveManifests = { epochs: epochManifest, events: eventManifest };
  return session.id as string;
}
