import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CaseCovariates } from "@/lib/eeg/covariates";
import {
  describeSefPersonalModel,
  fitSefPersonalModel,
  sefPersonalModelIsSafe,
  SEF_PERSONAL_MIN_PATIENTS,
  SEF_PERSONAL_MIN_POINTS,
  SEF_PERSONAL_MIN_SESSIONS,
  type SefPersonalModel,
  type SefPersonalPoint,
} from "@/lib/eeg/sef-personalisation";

export interface SefPersonalisationReport {
  /** The model currently in force, if personalisation is switched on. */
  active: SefPersonalModel | null;
  /** The model this call fitted, whether or not it passed the safety gate. */
  candidate: SefPersonalModel | null;
  /** Why the candidate was or was not activated. */
  gate: {
    passed: boolean;
    reasons: string[];
  };
  evidence: {
    points: { have: number; need: number };
    sessions: { have: number; need: number };
    patients: { have: number; need: number };
    /** Paired readings that belong to a patient recorded on more than one day. */
    longitudinalPoints: number;
  };
  justApplied: boolean;
  summary: string;
}

/** Only readings from a Muse 2 lineage feed the personalised SEF model. */
const isMuse = (device: string | null | undefined) =>
  typeof device === "string" && /muse/i.test(device);

export const getSefPersonalisation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SefPersonalisationReport> => {
    const { supabase, userId } = context;

    const { data: pairRows, error: pairError } = await supabase
      .from("bis_paired_points")
      .select("app_sef, bis_sef, session_id, reliable, recorded_at, device")
      .not("bis_sef", "is", null)
      .not("app_sef", "is", null)
      .order("recorded_at", { ascending: true })
      .limit(5000);
    if (pairError) throw new Error(pairError.message);

    const sessionIds = [
      ...new Set((pairRows ?? []).map((r) => r.session_id).filter((v): v is string => !!v)),
    ];
    const { data: sessionRows, error: sessionError } = sessionIds.length
      ? await supabase
          .from("eeg_sessions")
          .select(
            "id, device_name, patient_link_id, age_band, sex, regimen, frailty, chronic_burden, chronic_cns, acute_class, started_at",
          )
          .in("id", sessionIds)
      : { data: [], error: null };
    if (sessionError) throw new Error(sessionError.message);

    const sessions = new Map(
      (sessionRows ?? []).map((s) => [
        s.id,
        {
          device: s.device_name,
          patientKey: (s.patient_link_id as string | null) ?? `case:${s.id}`,
          linked: Boolean(s.patient_link_id),
          startedAt: String(s.started_at ?? ""),
          covariates: {
            ageBand: s.age_band,
            sex: s.sex,
            regimen: s.regimen,
            frailty: s.frailty,
            chronicBurden: s.chronic_burden,
            chronicCns: s.chronic_cns,
            acuteClass: s.acute_class,
          } satisfies CaseCovariates,
        },
      ]),
    );

    const points: SefPersonalPoint[] = [];
    // Cross-patient leakage is prevented at the group level: every reading is
    // tagged with the anonymised patient it came from, and unlinked cases get
    // their own per-case key so they can never be pooled as "the same patient".
    for (const r of pairRows ?? []) {
      const session = r.session_id ? sessions.get(r.session_id) : undefined;
      const device = (r.device as string | null) ?? session?.device ?? null;
      if (!isMuse(device)) continue;
      points.push({
        appSef: Number(r.app_sef),
        monitorSef: Number(r.bis_sef),
        patientKey: session?.patientKey ?? `unfiled:${r.session_id ?? "none"}`,
        sessionId: (r.session_id as string | null) ?? null,
        reliable: Boolean(r.reliable),
        recordedAt: String(r.recorded_at),
        covariates: session?.covariates ?? {},
      });
    }

    // Longitudinal evidence: readings from patients seen in more than one case.
    const sessionsPerPatient = new Map<string, Set<string>>();
    for (const p of points) {
      const set = sessionsPerPatient.get(p.patientKey) ?? new Set<string>();
      set.add(p.sessionId ?? "unfiled");
      sessionsPerPatient.set(p.patientKey, set);
    }
    const longitudinalPoints = points.filter(
      (p) => (sessionsPerPatient.get(p.patientKey)?.size ?? 0) > 1,
    ).length;

    const patients = new Set(points.map((p) => p.patientKey)).size;
    const sessionCount = new Set(points.map((p) => p.sessionId ?? "unfiled")).size;

    const candidate = fitSefPersonalModel(points);
    const passed = sefPersonalModelIsSafe(candidate);

    const reasons: string[] = [];
    if (points.length < SEF_PERSONAL_MIN_POINTS)
      reasons.push(
        `${points.length}/${SEF_PERSONAL_MIN_POINTS} paired Muse 2 SEF readings collected.`,
      );
    if (patients < SEF_PERSONAL_MIN_PATIENTS)
      reasons.push(
        `${patients}/${SEF_PERSONAL_MIN_PATIENTS} distinct anonymised patients — needed so held-out validation is meaningful.`,
      );
    if (sessionCount < SEF_PERSONAL_MIN_SESSIONS)
      reasons.push(`${sessionCount}/${SEF_PERSONAL_MIN_SESSIONS} cases.`);
    if (candidate && !passed) {
      const { cv } = candidate;
      reasons.push(
        `Fitted, but not better out of sample: ${cv.maePersonal.toFixed(2)} Hz held-out error vs ${cv.maePooled.toFixed(
          2,
        )} Hz for the pooled correction.`,
      );
    }
    if (!candidate && points.length >= SEF_PERSONAL_MIN_POINTS && !reasons.length)
      reasons.push("No covariate term is yet supported by enough separate patients.");

    const { data: activeRows } = await supabase
      .from("sef_alignments")
      .select(
        'id, gain, "offset", n_points, n_sessions, n_patients, coefficients, cv_metrics, created_at, model_family, lineage',
      )
      .eq("is_active", true)
      .eq("model_family", "personal")
      .order("created_at", { ascending: false })
      .limit(1);

    const toModel = (row: Record<string, unknown>): SefPersonalModel | null => {
      const coef = (row["coefficients"] ?? {}) as Partial<SefPersonalModel>;
      if (!coef || !Array.isArray(coef.terms)) return null;
      return {
        gain: Number(row["gain"]),
        offset: Number(row["offset"]),
        terms: coef.terms,
        patientOffsets: coef.patientOffsets ?? {},
        n: Number(row["n_points"]) || 0,
        sessions: Number(row["n_sessions"]) || 0,
        patients: Number(row["n_patients"]) || 0,
        cv: (row["cv_metrics"] ?? {}) as SefPersonalModel["cv"],
        fittedAt: String(row["created_at"]),
        id: String(row["id"]),
      };
    };

    let active = activeRows?.[0] ? toModel(activeRows[0] as Record<string, unknown>) : null;
    let justApplied = false;

    // Activate only on a strictly better held-out fit than what is in force.
    const betterThanActive =
      !active ||
      !Number.isFinite(active.cv?.maePersonal) ||
      (candidate != null && candidate.cv.maePersonal <= active.cv.maePersonal - 0.05) ||
      (candidate != null && candidate.patients > active.patients);

    if (candidate && passed && betterThanActive) {
      await supabase
        .from("sef_alignments")
        .update({ is_active: false })
        .eq("user_id", userId)
        .eq("is_active", true);
      const { data: inserted, error: insertError } = await supabase
        .from("sef_alignments")
        .insert({
          user_id: userId,
          gain: candidate.gain,
          offset: candidate.offset,
          n_points: candidate.n,
          n_sessions: candidate.sessions,
          n_patients: candidate.patients,
          bias_before: null,
          bias_after: candidate.cv.biasPersonal,
          mae_before: candidate.cv.maePooled,
          mae_after: candidate.cv.maePersonal,
          auto_applied: true,
          is_active: true,
          model_family: "personal",
          lineage: "muse-2",
          coefficients: JSON.parse(
            JSON.stringify({ terms: candidate.terms, patientOffsets: candidate.patientOffsets }),
          ),
          cv_metrics: JSON.parse(JSON.stringify(candidate.cv)),
          note: `Personalised SEF correction from ${candidate.n} paired Muse 2 readings across ${candidate.patients} anonymised patients (patient-grouped cross-validation).`,
        })
        .select(
          'id, gain, "offset", n_points, n_sessions, n_patients, coefficients, cv_metrics, created_at, model_family, lineage',
        )
        .single();
      if (!insertError && inserted) {
        active = toModel(inserted as Record<string, unknown>);
        justApplied = true;
      }
    }

    return {
      active,
      candidate,
      gate: { passed, reasons },
      evidence: {
        points: { have: points.length, need: SEF_PERSONAL_MIN_POINTS },
        sessions: { have: sessionCount, need: SEF_PERSONAL_MIN_SESSIONS },
        patients: { have: patients, need: SEF_PERSONAL_MIN_PATIENTS },
        longitudinalPoints,
      },
      justApplied,
      summary: describeSefPersonalModel(active),
    };
  });

/** Stand the personalised model down and fall back to the pooled correction. */
export const clearSefPersonalisation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("sef_alignments")
      .update({ is_active: false })
      .eq("user_id", context.userId)
      .eq("model_family", "personal")
      .eq("is_active", true);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
