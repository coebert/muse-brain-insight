/**
 * Automatic migration of legacy saved models and detector configs.
 *
 * Threshold fields have been renamed over the life of the app
 * (`seizureScoreThreshold` → `seizureThreshold`, `seizureMinEpochs` →
 * `seizureEpochs`, and the same for the suppression pair). A model or
 * threshold set written by an older build is still clinically valid — the
 * numbers were fitted honestly — so it should be upgraded in place rather
 * than discarded. What must never happen is a legacy field being silently
 * ignored, leaving the detector running on a default threshold while the UI
 * shows the saved one.
 *
 * Everything here is pure and side-effect free apart from the explicit
 * storage sweep, which rewrites migrated records so the conversion happens
 * once rather than on every read.
 */
import {
  parseDetectorThresholds,
  parseLineageConfigs,
  type DetectorThresholdConfig,
  type LineageConfigParse,
} from "./model-config-schema";

/** Old field name → current field name. */
export const LEGACY_THRESHOLD_FIELDS: Record<string, string> = {
  seizureScoreThreshold: "seizureThreshold",
  seizureMinEpochs: "seizureEpochs",
  seizureScore: "seizureThreshold",
  seizureConsecutiveEpochs: "seizureEpochs",
  suppressionUv: "suppressionThresholdUv",
  suppressionThreshold: "suppressionThresholdUv",
  srWindow: "srWindowSeconds",
  srWindowSec: "srWindowSeconds",
};

/** Current schema version stamped onto migrated records. */
export const MODEL_CONFIG_VERSION = 2;

export interface MigrationChange {
  /** Dotted path of the object the field sat on, "" for the root. */
  path: string;
  from: string;
  to: string;
  /** Set when both names were present and the legacy one was discarded. */
  conflicted?: boolean;
}

export interface MigrationResult<T> {
  value: T;
  changes: MigrationChange[];
  /** True when anything was renamed. */
  migrated: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recursively rename legacy threshold fields anywhere inside a saved record.
 * When both the legacy and current name are present the current one wins and
 * the collision is reported, so a half-migrated record cannot regress.
 */
export function migrateLegacyFields<T>(input: T): MigrationResult<T> {
  const changes: MigrationChange[] = [];

  function walk(value: unknown, path: string): unknown {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      const child = walk(raw, path ? `${path}.${key}` : key);
      const renamed = LEGACY_THRESHOLD_FIELDS[key];
      if (!renamed) {
        out[key] = child;
        continue;
      }
      const conflicted = Object.prototype.hasOwnProperty.call(value, renamed);
      changes.push({ path, from: key, to: renamed, ...(conflicted ? { conflicted: true } : {}) });
      if (conflicted) continue; // current name already carries the value
      out[renamed] = child;
    }
    return out;
  }

  const value = walk(input, "") as T;
  return { value, changes, migrated: changes.length > 0 };
}

/** Human-readable summary of a migration, for logs and the audit trail. */
export function describeMigration(changes: MigrationChange[]): string {
  if (changes.length === 0) return "no legacy fields found";
  return changes
    .map((c) => {
      const where = c.path ? `${c.path}.` : "";
      return c.conflicted
        ? `${where}${c.from} dropped (${c.to} already set)`
        : `${where}${c.from} → ${c.to}`;
    })
    .join("; ");
}

/**
 * Migrate then validate a saved threshold set. Returns null only when the
 * record is unusable even after renaming — a genuinely broken config.
 */
export function migrateDetectorThresholds(
  value: unknown,
): (MigrationResult<DetectorThresholdConfig> & { ok: true }) | { ok: false; issues: string[] } {
  const migrated = migrateLegacyFields(value);
  const parsed = parseDetectorThresholds(migrated.value);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  return { ok: true, value: parsed.value, changes: migrated.changes, migrated: migrated.migrated };
}

/** Migrate a whole per-lineage bundle before it is validated. */
export function migrateLineageConfigs(
  value: unknown,
): LineageConfigParse & { changes: MigrationChange[] } {
  const migrated = migrateLegacyFields(value);
  const parsed = parseLineageConfigs(migrated.value);
  return { ...parsed, changes: migrated.changes };
}

/**
 * Migrate a saved model record of any vintage: flat thresholds, thresholds
 * nested under a `thresholds`/`settings` key, or a model bundle. The version
 * stamp lets a later read skip the walk.
 */
export function migrateSavedModel(
  value: unknown,
): MigrationResult<Record<string, unknown>> & { alreadyCurrent: boolean } {
  if (!isPlainObject(value)) {
    return { value: {}, changes: [], migrated: false, alreadyCurrent: false };
  }
  const alreadyCurrent = value["configVersion"] === MODEL_CONFIG_VERSION;
  if (alreadyCurrent) return { value, changes: [], migrated: false, alreadyCurrent: true };
  const result = migrateLegacyFields(value);
  return {
    value: { ...result.value, configVersion: MODEL_CONFIG_VERSION },
    changes: result.changes,
    migrated: result.migrated,
    alreadyCurrent: false,
  };
}

/* ------------------------------------------------------------------ */
/* Storage sweep                                                       */
/* ------------------------------------------------------------------ */

export interface StorageMigrationReport {
  key: string;
  changes: MigrationChange[];
}

/**
 * Rewrite any stored JSON record that still carries legacy threshold names.
 * Runs once at start-up; keys that are not JSON objects are left untouched.
 */
export function migrateStoredModelConfigs(
  storage: Pick<Storage, "getItem" | "setItem" | "key" | "length">,
  keys?: string[],
): StorageMigrationReport[] {
  const targets =
    keys ??
    Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (k): k is string => typeof k === "string",
    );
  const reports: StorageMigrationReport[] = [];
  for (const key of targets) {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    if (!raw || (!raw.startsWith("{") && !raw.startsWith("["))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = migrateLegacyFields(parsed);
    if (!result.migrated) continue;
    try {
      storage.setItem(key, JSON.stringify(result.value));
      reports.push({ key, changes: result.changes });
    } catch {
      // Storage full or blocked: the in-memory read path still migrates.
      reports.push({ key, changes: result.changes });
    }
  }
  return reports;
}

/** Convenience wrapper for the browser; a no-op during SSR. */
export function migrateBrowserModelConfigs(): StorageMigrationReport[] {
  if (typeof window === "undefined") return [];
  try {
    return migrateStoredModelConfigs(window.localStorage);
  } catch {
    return [];
  }
}
