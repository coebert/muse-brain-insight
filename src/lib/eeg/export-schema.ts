/**
 * Schema and readiness checks for diagnostic exports.
 *
 * Two problems this solves:
 *
 *  * A capture that looks fine on the phone can be useless offline — packets
 *    truncated, hex elided, log empty. Every export is validated against a
 *    Zod schema before it leaves the device and again when it is imported, so
 *    a malformed capture is caught immediately rather than hours later.
 *  * Sessions could not be compared, because captures carried no stable
 *    context. Each export now embeds patient-safe metadata: export time,
 *    device label/model/firmware, sampling rate and an anonymisation tag.
 *    None of it identifies a patient — the tag is a one-way token derived
 *    from device and session-start values only.
 */

import { z } from "zod";

export const EXPORT_SCHEMA_VERSION = 1;

export type DiagnosticExportKind = "ble-log" | "debug-session";

/* ------------------------------------------------------------------ */
/* Patient-safe metadata                                               */
/* ------------------------------------------------------------------ */

export const exportDeviceSchema = z.object({
  label: z.string().min(1),
  model: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  firmwareVersion: z.string().nullable().optional(),
  hardwareVersion: z.string().nullable().optional(),
});

export const exportMetaSchema = z.object({
  schemaVersion: z.number().int().positive(),
  kind: z.enum(["ble-log", "debug-session"]),
  exportedAt: z.string().min(1),
  exportedAtEpoch: z.number().int().nonnegative(),
  sessionStartedAt: z.number().int().nonnegative().nullable(),
  device: exportDeviceSchema,
  sampleRateHz: z.number().positive().nullable(),
  anonymisation: z.object({
    tag: z.string().regex(/^ANON-[0-9A-Z]{8}$/),
    scheme: z.literal("device-session-hash"),
    containsPatientData: z.literal(false),
  }),
  userAgent: z.string().optional(),
});

export type ExportMeta = z.infer<typeof exportMetaSchema>;
export type ExportDeviceInfo = z.infer<typeof exportDeviceSchema>;

/** One-way, non-identifying token so repeat captures of one session match. */
export function anonymisationTag(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let mix = hash;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[mix % 32];
    mix = Math.floor(mix / 32) + Math.imul(mix, 3) % 977;
  }
  return `ANON-${out}`;
}

export interface ExportMetaInput {
  kind: DiagnosticExportKind;
  deviceLabel?: string | null | undefined;
  deviceInfo?: Partial<ExportDeviceInfo> | null;
  sampleRate?: number | null;
  startedAt?: number | null;
}

export function buildExportMeta(input: ExportMetaInput): ExportMeta {
  const now = Date.now();
  const label = input.deviceLabel?.trim() || input.deviceInfo?.label?.trim() || "unknown device";
  const device: ExportDeviceInfo = {
    label,
    model: input.deviceInfo?.model ?? null,
    manufacturer: input.deviceInfo?.manufacturer ?? null,
    firmwareVersion: input.deviceInfo?.firmwareVersion ?? null,
    hardwareVersion: input.deviceInfo?.hardwareVersion ?? null,
  };
  const startedAt = typeof input.startedAt === "number" ? Math.max(0, Math.round(input.startedAt)) : null;
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    kind: input.kind,
    exportedAt: new Date(now).toISOString(),
    exportedAtEpoch: now,
    sessionStartedAt: startedAt,
    device,
    sampleRateHz: typeof input.sampleRate === "number" && input.sampleRate > 0 ? input.sampleRate : null,
    anonymisation: {
      tag: anonymisationTag(
        [label, device.model ?? "", device.firmwareVersion ?? "", startedAt ?? "live"].join("|"),
      ),
      scheme: "device-session-hash",
      containsPatientData: false,
    },
    userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
  };
}

/* ------------------------------------------------------------------ */
/* Export document schemas                                             */
/* ------------------------------------------------------------------ */

const hexSchema = z.string();

export const bleLogEntrySchema = z.object({
  /** Relative time; optional because early captures did not record it. */
  t: z.number().optional(),
  at: z.number(),
  kind: z.enum([
    "session",
    "gatt",
    "service",
    "characteristic",
    "command",
    "response",
    "packet",
    "error",
    "info",
  ]),
  message: z.string(),
  data: z.record(z.unknown()).optional(),
  hex: hexSchema.optional(),
  rawHex: hexSchema.optional(),
  bytes: z.number().optional(),
});

export const blePacketRecordSchema = z.object({
  at: z.number(),
  source: z.string(),
  format: z.string(),
  hex: hexSchema,
  bytes: z.number(),
  decodedSamples: z.number(),
  amplitudeUv: z.number(),
  deltaMs: z.number(),
});

export const bleLogExportSchema = z.object({
  meta: exportMetaSchema.optional(),
  exportedAt: z.string().optional(),
  userAgent: z.string().optional(),
  packetTotals: z.record(z.number()).optional(),
  entries: z.array(bleLogEntrySchema),
});

export const debugSessionExportSchema = z.object({
  meta: exportMetaSchema.optional(),
  exportedAt: z.string().optional(),
  device: z.string().optional(),
  sampleRate: z.number().optional(),
  startedAt: z.number().nullable().optional(),
  spectrum: z
    .object({ minHz: z.number(), maxHz: z.number(), bins: z.number() })
    .optional(),
  frames: z.array(z.record(z.unknown())).optional(),
  packets: z.array(blePacketRecordSchema).optional(),
  connectionLog: z.array(bleLogEntrySchema).optional(),
});

/* ------------------------------------------------------------------ */
/* Validation and decoder readiness                                    */
/* ------------------------------------------------------------------ */

export type DecoderReadyLevel = "ready" | "partial" | "invalid";

export interface DiagnosticExportCheck {
  ok: boolean;
  level: DecoderReadyLevel;
  kind: DiagnosticExportKind | null;
  meta: ExportMeta | null;
  /** Complete, replayable raw notification packets found in the file. */
  replayablePackets: number;
  /** Packet entries whose bytes were truncated and cannot be replayed. */
  truncatedPackets: number;
  issues: string[];
  summary: string;
}

/** Minimum complete packets for the format detector to rank a decoder. */
const MIN_REPLAYABLE_PACKETS = 4;

function isCompleteHex(value: string | undefined): boolean {
  if (!value) return false;
  if (value.includes("…")) return false;
  const compact = value.replace(/\s+/g, "");
  return compact.length >= 2 && compact.length % 2 === 0 && /^[0-9a-f]+$/i.test(compact);
}

function countPackets(
  entries: Array<z.infer<typeof bleLogEntrySchema>> | undefined,
  packets: Array<z.infer<typeof blePacketRecordSchema>> | undefined,
) {
  let replayable = 0;
  let truncated = 0;
  for (const entry of entries ?? []) {
    if (entry.kind !== "packet") continue;
    if (isCompleteHex(entry.rawHex ?? entry.hex)) replayable++;
    else truncated++;
  }
  if (!replayable) {
    for (const packet of packets ?? []) {
      if (isCompleteHex(packet.hex)) replayable++;
      else truncated++;
    }
  }
  return { replayable, truncated };
}

/**
 * Validates any diagnostic export (object or JSON text) and reports whether
 * the decoder can actually be re-run against it.
 */
export function validateDiagnosticExport(input: unknown): DiagnosticExportCheck {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return {
        ok: false,
        level: "invalid",
        kind: null,
        meta: null,
        replayablePackets: 0,
        truncatedPackets: 0,
        issues: ["The file is not valid JSON."],
        summary: "Not a diagnostic capture",
      };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      level: "invalid",
      kind: null,
      meta: null,
      replayablePackets: 0,
      truncatedPackets: 0,
      issues: ["The capture must be a JSON object."],
      summary: "Not a diagnostic capture",
    };
  }

  const record = value as Record<string, unknown>;
  const looksLikeSession = "frames" in record || "connectionLog" in record || "packets" in record;
  const schema = looksLikeSession ? debugSessionExportSchema : bleLogExportSchema;
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    return {
      ok: false,
      level: "invalid",
      kind: looksLikeSession ? "debug-session" : "ble-log",
      meta: null,
      replayablePackets: 0,
      truncatedPackets: 0,
      issues: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`),
      summary: "Malformed capture",
    };
  }

  const data = parsed.data as z.infer<typeof debugSessionExportSchema> &
    z.infer<typeof bleLogExportSchema>;
  const entries = looksLikeSession ? data.connectionLog : data.entries;
  const { replayable, truncated } = countPackets(entries, data.packets);
  const issues: string[] = [];
  if (!data.meta) issues.push("No patient-safe metadata block (captured by an older app version).");
  else if (data.meta.schemaVersion > EXPORT_SCHEMA_VERSION)
    issues.push(`Capture uses schema v${data.meta.schemaVersion}; this app understands v${EXPORT_SCHEMA_VERSION}.`);
  if (truncated) issues.push(`${truncated} packet(s) have truncated bytes and cannot be replayed.`);
  if (!replayable)
    issues.push("No complete raw notification packets — enable diagnostic capture before pairing.");
  else if (replayable < MIN_REPLAYABLE_PACKETS)
    issues.push(`Only ${replayable} complete packet(s); at least ${MIN_REPLAYABLE_PACKETS} are needed to rank a decoder.`);

  const level: DecoderReadyLevel =
    replayable >= MIN_REPLAYABLE_PACKETS ? (data.meta ? "ready" : "partial") : replayable ? "partial" : "invalid";

  return {
    ok: level !== "invalid",
    level,
    kind: looksLikeSession ? "debug-session" : "ble-log",
    meta: data.meta ?? null,
    replayablePackets: replayable,
    truncatedPackets: truncated,
    issues,
    summary:
      level === "ready"
        ? `Decoder-ready · ${replayable} replayable packets`
        : level === "partial"
          ? `Usable with limits · ${replayable} replayable packets`
          : "Not decoder-ready",
  };
}
