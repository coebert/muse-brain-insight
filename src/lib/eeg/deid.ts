/**
 * Automatic de-identification of clinician free text.
 *
 * Everything typed into a case (notes, summary, diagnosis, location, markers)
 * is passed through this scrubber before it is encrypted and stored, so a
 * recording can be reviewed later without any direct identifier surviving in
 * the record. Patients are re-identified only through the sealed linkage
 * table, never through the case text itself.
 */

export type DeidKind =
  | "nhs_number"
  | "hospital_number"
  | "date"
  | "email"
  | "phone"
  | "postcode"
  | "name"
  | "url";

export interface DeidFinding {
  kind: DeidKind;
  /** How many separate matches of this kind were replaced. */
  count: number;
}

export interface DeidResult {
  text: string;
  findings: DeidFinding[];
}

const LABELS: Record<DeidKind, string> = {
  nhs_number: "NHS number",
  hospital_number: "hospital number",
  date: "date",
  email: "email address",
  phone: "phone number",
  postcode: "postcode",
  name: "name",
  url: "web address",
};

export function deidLabel(kind: DeidKind): string {
  return LABELS[kind] ?? kind;
}

const PLACEHOLDER: Record<DeidKind, string> = {
  nhs_number: "[NHS-NUMBER REMOVED]",
  hospital_number: "[ID REMOVED]",
  date: "[DATE REMOVED]",
  email: "[EMAIL REMOVED]",
  phone: "[PHONE REMOVED]",
  postcode: "[POSTCODE REMOVED]",
  name: "[NAME REMOVED]",
  url: "[LINK REMOVED]",
};

/**
 * Clinical words that look like a title-cased name but are not — kept short and
 * specific so genuine names are still caught.
 */
const NAME_STOPWORDS = new Set(
  [
    "Theatre",
    "Recovery",
    "Ward",
    "Bed",
    "ICU",
    "HDU",
    "Propofol",
    "Ketamine",
    "Alfentanil",
    "Remifentanil",
    "Rocuronium",
    "Sevoflurane",
    "Midazolam",
    "Fentanyl",
    "Noradrenaline",
    "Metaraminol",
    "Sepsis",
    "Delirium",
    "Laparotomy",
    "Emergency",
    "Elective",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
    "Burst",
    "Suppression",
    "Patient",
    "Consultant",
    "Anaesthetist",
    "Registrar",
    "Nurse",
  ].map((w) => w),
);

interface Rule {
  kind: DeidKind;
  re: RegExp;
  /** Optional guard so a match can be skipped without counting it. */
  skip?: (match: string) => boolean;
}

/** Order matters: the most specific patterns run first. */
const RULES: Rule[] = [
  { kind: "url", re: /\bhttps?:\/\/\S+/gi },
  { kind: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi },
  // NHS number: 10 digits, optionally spaced 3-3-4.
  { kind: "nhs_number", re: /\b\d{3}[ -]?\d{3}[ -]?\d{4}\b/g },
  // UK phone numbers: 10–11 digits starting 0, or the +44 form, however spaced.
  {
    kind: "phone",
    re: /(?:\+44\s?)?\(?0\d{1,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
    skip: (m) => {
      const digits = m.replace(/\D/g, "").length;
      return digits < 10 || digits > 12;
    },
  },
  // Hospital / MRN style: letters+digits or a labelled number.
  {
    kind: "hospital_number",
    re: /\b(?:MRN|RXH|hosp(?:ital)?\s*(?:no\.?|number|#)|unit\s*no\.?)\s*:?\s*[A-Z0-9-]{4,}\b/gi,
  },
  { kind: "hospital_number", re: /\b[A-Z]{1,3}\d{6,10}\b/g },
  // Dates: 12/03/1948, 12-3-48, 1948-03-12, 12 March 1948.
  { kind: "date", re: /\b\d{4}-\d{1,2}-\d{1,2}\b/g },
  { kind: "date", re: /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g },
  {
    kind: "date",
    re: /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4}\b/gi,
  },
  { kind: "postcode", re: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi },
  // Explicitly labelled names, e.g. "patient: John Smith", "Mrs Jane Doe".
  {
    kind: "name",
    re: /\b(?:patient|pt|name|mr|mrs|ms|miss|dr|prof)\.?\s*:?\s+[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?\b/g,
  },
  // Two consecutive capitalised words that are not clinical vocabulary.
  {
    kind: "name",
    re: /\b[A-Z][a-z]{1,20}\s+[A-Z][a-z]{1,20}\b/g,
    skip: (m) => m.split(/\s+/).some((w) => NAME_STOPWORDS.has(w)),
  },
];

/**
 * Replace every direct identifier found in `input` with a marker describing
 * what was removed. Returns the cleaned text plus a tally per identifier type.
 */
export function scrubText(input: string | null | undefined): DeidResult {
  const text = input ?? "";
  if (!text.trim()) return { text: text ?? "", findings: [] };

  let working = text;
  const counts = new Map<DeidKind, number>();

  for (const rule of RULES) {
    working = working.replace(new RegExp(rule.re.source, rule.re.flags), (match) => {
      if (rule.skip?.(match)) return match;
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      return PLACEHOLDER[rule.kind];
    });
  }

  const findings = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  findings.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  return { text: working, findings };
}

/** Combine per-field tallies into one summary for the whole case. */
export function mergeFindings(groups: DeidFinding[][]): DeidFinding[] {
  const counts = new Map<DeidKind, number>();
  for (const group of groups) {
    for (const f of group) counts.set(f.kind, (counts.get(f.kind) ?? 0) + f.count);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/** One-line clinician-facing description of what the scrubber removed. */
export function summariseFindings(findings: DeidFinding[]): string {
  if (!findings.length) return "No identifiers detected.";
  const parts = findings.map(
    (f) => `${f.count} ${deidLabel(f.kind)}${f.count === 1 ? "" : "s"}`,
  );
  return `Removed ${parts.join(", ")}.`;
}

/** Scrub every free-text field of a case in one pass. */
export function scrubCaseText<T extends Record<string, string | null | undefined>>(
  fields: T,
): { fields: { [K in keyof T]: string | null }; findings: DeidFinding[] } {
  const out = {} as { [K in keyof T]: string | null };
  const groups: DeidFinding[][] = [];
  for (const key of Object.keys(fields) as (keyof T)[]) {
    const raw = fields[key];
    if (raw === null || raw === undefined || raw === "") {
      out[key] = raw === undefined ? null : (raw as string | null);
      continue;
    }
    const result = scrubText(raw);
    out[key] = result.text;
    groups.push(result.findings);
  }
  return { fields: out, findings: mergeFindings(groups) };
}

const PSEUDONYM_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679";

/** Mint a non-sequential, non-identifying patient pseudonym, e.g. `PT-K7QF`. */
export function generatePseudonym(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += PSEUDONYM_ALPHABET[Math.floor(random() * PSEUDONYM_ALPHABET.length)];
  }
  return `PT-${out}`;
}

/**
 * Normalise a hospital identifier before fingerprinting so the same patient
 * entered as "RXH 123 4567" and "rxh1234567" links to one pseudonym.
 */
export function normaliseIdentifier(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
