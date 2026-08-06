/**
 * Local archive of anonymised case codes already used on this device.
 *
 * Codes are encrypted before they reach the database, so duplicates cannot be
 * spotted server-side. Keeping a plain local ledger of codes (which by design
 * carry no patient identifier) lets the app refuse to reuse one and warn when a
 * re-rolled code collides.
 */
const KEY = "cortextrace.usedCaseCodes";

/** Cap the ledger so long-running devices do not grow storage without bound. */
const MAX_CODES = 2000;

/** Codes compare case-insensitively and ignore surrounding whitespace. */
export function normaliseCaseCode(code: string): string {
  return code.trim().toUpperCase();
}

export function loadUsedCaseCodes(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  } catch {
    return [];
  }
}

function persist(codes: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(codes.slice(-MAX_CODES)));
  } catch {
    /* storage unavailable */
  }
}

/** Records a filed case code; returns the updated ledger. */
export function rememberCaseCode(code: string): string[] {
  const wanted = normaliseCaseCode(code);
  if (!wanted) return loadUsedCaseCodes();
  const codes = loadUsedCaseCodes();
  if (codes.some((c) => normaliseCaseCode(c) === wanted)) return codes;
  const next = [...codes, code.trim()];
  persist(next);
  return next;
}

export function isCaseCodeUsed(code: string, used: string[]): boolean {
  const wanted = normaliseCaseCode(code);
  if (!wanted) return false;
  return used.some((c) => normaliseCaseCode(c) === wanted);
}

export interface UniqueCodeResult {
  code: string;
  /** How many generated candidates collided with the archive before this one. */
  collisions: number;
  /** False when every attempt collided and the code may still be a duplicate. */
  unique: boolean;
}

/**
 * Mints a code that is not already in the local archive, re-rolling on
 * collision. Reports collisions so the UI can warn the clinician.
 */
export function generateUniqueCaseCode(
  used: string[],
  make: () => string,
  attempts = 12,
): UniqueCodeResult {
  let collisions = 0;
  let code = make();
  for (let i = 0; i < attempts && isCaseCodeUsed(code, used); i += 1) {
    collisions += 1;
    code = make();
  }
  return { code, collisions, unique: !isCaseCodeUsed(code, used) };
}
