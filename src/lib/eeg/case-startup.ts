/**
 * Remembers how the last case was set up on this device so the next one starts
 * in two taps: same context and location, and the next sequential case code.
 */
const KEY = "cortextrace.lastCaseSetup";

export interface CaseStartupPrefs {
  context: string;
  location: string;
  /** Case code used last time, e.g. "ICU-007". */
  lastCaseCode: string;
  /** Monitoring mode (and therefore detection preset) used last time. */
  mode: "anaesthesia" | "icu";
}

export function loadCaseStartup(): CaseStartupPrefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CaseStartupPrefs>;
    return {
      context: typeof parsed.context === "string" ? parsed.context : "general_anaesthesia",
      location: typeof parsed.location === "string" ? parsed.location : "",
      lastCaseCode: typeof parsed.lastCaseCode === "string" ? parsed.lastCaseCode : "",
      mode: parsed.mode === "icu" ? "icu" : "anaesthesia",
    };
  } catch {
    return null;
  }
}

export function saveCaseStartup(prefs: CaseStartupPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}

/**
 * "ICU-007" -> "ICU-008"; a code with no trailing number gets "-2".
 * Anything unparseable comes back empty so the clinician types their own.
 */
export function nextCaseCode(previous: string): string {
  const code = previous.trim();
  if (!code) return "";
  const match = /^(.*?)(\d+)$/.exec(code);
  if (!match) return `${code}-2`;
  const [, prefix = "", digits = "0"] = match;
  const next = String(Number(digits) + 1).padStart(digits.length, "0");
  return `${prefix}${next}`;
}

const CONTEXT_PREFIX: Record<string, string> = {
  general_anaesthesia: "GA",
  icu_sedation: "ICU",
  procedural_sedation: "PS",
  other: "CT",
};

/** Ambiguity-free alphabet: no I, O, 0, 1. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A fresh anonymised code that carries no patient identifier: context prefix,
 * the date the case was opened, and a random suffix, e.g. "GA-260806-K7QF".
 * The random part means two clinicians opening cases on the same day on
 * different devices will not collide, and nothing about the code can be
 * traced back to the patient.
 */
export function generateCaseCode(
  context: string,
  now: Date = new Date(),
  random: () => number = Math.random,
): string {
  const prefix = CONTEXT_PREFIX[context] ?? "CT";
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 4; i += 1) {
    suffix += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  }
  return `${prefix}-${yy}${mm}${dd}-${suffix}`;
}
