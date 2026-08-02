import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Encrypt free-text patient fields before they are written to the database. */
export const sealTexts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { values: (string | null)[] }) => data)
  .handler(async ({ data }) => {
    const { seal } = await import("./privacy.server");
    return { values: data.values.map((v) => seal(v)) };
  });

/** Decrypt free-text patient fields for display to their owner. */
export const openTexts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { values: (string | null)[] }) => data)
  .handler(async ({ data }) => {
    const { open } = await import("./privacy.server");
    return { values: data.values.map((v) => open(v)) };
  });

/** Full decrypted export of the signed-in clinician's records (optionally one session). */
export const exportMyData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId?: string | null }) => data)
  .handler(async ({ data, context }) => {
    const { open } = await import("./privacy.server");
    const { supabase, userId } = context;

    let sessionQuery = supabase.from("eeg_sessions").select("*").eq("user_id", userId);
    if (data.sessionId) sessionQuery = sessionQuery.eq("id", data.sessionId);
    const { data: sessions, error } = await sessionQuery.order("created_at", { ascending: true });
    if (error) throw error;

    const ids = (sessions ?? []).map((s) => s.id);
    const child = async (table: "eeg_epochs" | "eeg_events" | "depth_state_labels") => {
      if (!ids.length) return [];
      const { data: rows, error: e } = await supabase
        .from(table)
        .select("*")
        .eq("user_id", userId)
        .in("session_id", ids);
      if (e) throw e;
      return rows ?? [];
    };

    return {
      exported_at: new Date().toISOString(),
      format: "cortextrace-export/1",
      encryption: "Free-text fields are stored AES-256-GCM encrypted and decrypted for this export.",
      sessions: (sessions ?? []).map((s) => ({
        ...s,
        case_code: open(s.case_code),
        notes: open(s.notes),
        admission_diagnosis: open(s.admission_diagnosis),
        location: open(s.location),
      })),
      epochs: await child("eeg_epochs"),
      events: await child("eeg_events"),
      labels: await child("depth_state_labels"),
    };
  });

/** Permanently delete one session and every record attached to it. */
export const deleteSessionData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string }) => data)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    for (const table of ["eeg_epochs", "eeg_events", "depth_state_labels"] as const) {
      const { error } = await supabase
        .from(table)
        .delete()
        .eq("user_id", userId)
        .eq("session_id", data.sessionId);
      if (error) throw error;
    }
    const { error } = await supabase
      .from("eeg_sessions")
      .delete()
      .eq("user_id", userId)
      .eq("id", data.sessionId);
    if (error) throw error;
    return { ok: true as const };
  });

/** Permanently delete every stored patient record for the signed-in clinician. */
export const deleteAllMyData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    for (const table of [
      "eeg_epochs",
      "eeg_events",
      "depth_state_labels",
      "eeg_sessions",
    ] as const) {
      const { error } = await supabase.from(table).delete().eq("user_id", userId);
      if (error) throw error;
    }
    return { ok: true as const };
  });