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
