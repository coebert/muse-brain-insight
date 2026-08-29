import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generatePseudonym, normaliseIdentifier } from "@/lib/eeg/deid";

export interface PatientLinkSummary {
  id: string;
  pseudonym: string;
  createdAt: string;
  /** True when this call created the link rather than matching an existing one. */
  created: boolean;
}

/**
 * Turn a hospital identifier into a stable pseudonym for this clinician.
 *
 * The identifier is sealed with AES-256-GCM and matched by keyed fingerprint,
 * so the same patient always resolves to the same pseudonym while nothing
 * readable is written alongside the recording.
 */
export const linkPatient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { identifier: string; label?: string | null }) => data)
  .handler(async ({ data, context }): Promise<PatientLinkSummary> => {
    const normalised = normaliseIdentifier(data.identifier);
    if (normalised.length < 3) throw new Error("Enter at least three characters of the identifier.");

    const { supabase, userId } = context;
    const { seal } = await import("@/lib/privacy.server");
    const { fingerprintIdentifier } = await import("./patient-link.server");
    const fingerprint = fingerprintIdentifier(normalised);

    const { data: existing, error: findError } = await supabase
      .from("patient_links")
      .select("id, pseudonym, created_at")
      .eq("user_id", userId)
      .eq("identifier_fingerprint", fingerprint)
      .maybeSingle();
    if (findError) throw findError;
    if (existing) {
      return {
        id: existing.id,
        pseudonym: existing.pseudonym,
        createdAt: existing.created_at,
        created: false,
      };
    }

    // Retry on the (rare) pseudonym collision within this clinician's records.
    for (let attempt = 0; attempt < 8; attempt++) {
      const pseudonym = generatePseudonym();
      const { data: row, error } = await supabase
        .from("patient_links")
        .insert({
          user_id: userId,
          pseudonym,
          identifier_sealed: seal(normalised) ?? "",
          identifier_fingerprint: fingerprint,
          label_sealed: seal(data.label?.trim() || null),
        })
        .select("id, pseudonym, created_at")
        .single();
      if (!error && row) {
        return { id: row.id, pseudonym: row.pseudonym, createdAt: row.created_at, created: true };
      }
      // 23505 = unique violation: either a duplicate pseudonym or a race on the
      // fingerprint, in which case the existing link is the right answer.
      if (error && error.code !== "23505") throw error;
      const { data: raced } = await supabase
        .from("patient_links")
        .select("id, pseudonym, created_at")
        .eq("user_id", userId)
        .eq("identifier_fingerprint", fingerprint)
        .maybeSingle();
      if (raced) {
        return {
          id: raced.id,
          pseudonym: raced.pseudonym,
          createdAt: raced.created_at,
          created: false,
        };
      }
    }
    throw new Error("Could not create a patient link — please try again.");
  });

/**
 * Reveal the sealed identifier behind one pseudonym. Deliberately a separate,
 * explicit call so identifiers never travel with routine case reads.
 */
export const revealPatientIdentifier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { linkId: string }) => data)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { open } = await import("@/lib/privacy.server");
    const { data: row, error } = await supabase
      .from("patient_links")
      .select("id, pseudonym, identifier_sealed, label_sealed")
      .eq("user_id", userId)
      .eq("id", data.linkId)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("That patient link no longer exists.");
    return {
      pseudonym: row.pseudonym,
      identifier: open(row.identifier_sealed),
      label: open(row.label_sealed),
    };
  });

/** Pseudonyms only — safe to render in any list. */
export const listPatientLinks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("patient_links")
      .select("id, pseudonym, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return { links: data ?? [] };
  });

/** Forget the identifier behind a pseudonym, leaving the recordings anonymous. */
export const breakPatientLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { linkId: string }) => data)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("patient_links")
      .delete()
      .eq("user_id", userId)
      .eq("id", data.linkId);
    if (error) throw error;
    return { ok: true as const };
  });

/**
 * Resolve an identifier to an *existing* pseudonym without creating one.
 *
 * Used while a case is running so the personalised SEF model can apply that
 * patient's own longitudinal offset when they have been recorded before. It
 * deliberately never creates a linkage record, and returns only the opaque
 * link id and pseudonym.
 */
export const lookupPatientLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { identifier: string }) => data)
  .handler(async ({ data, context }): Promise<{ id: string; pseudonym: string } | null> => {
    const normalised = normaliseIdentifier(data.identifier);
    if (normalised.length < 3) return null;
    const { fingerprintIdentifier } = await import("./patient-link.server");
    const { data: row, error } = await context.supabase
      .from("patient_links")
      .select("id, pseudonym")
      .eq("user_id", context.userId)
      .eq("identifier_fingerprint", fingerprintIdentifier(normalised))
      .maybeSingle();
    if (error) throw error;
    return row ? { id: row.id, pseudonym: row.pseudonym } : null;
  });
