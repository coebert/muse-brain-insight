/**
 * Server-side output restrictions for the AI session reviewer.
 *
 * The language model is an EXPLANATORY layer over metrics the app has
 * already computed and verified. It does not read raw EEG, it does not learn
 * from clinician thumbs-up/down, and it does not make treatment decisions.
 * The prompt says so, but prompts are advisory; this module enforces it on
 * the parsed output before anything reaches the clinician:
 *
 *   - Drug-titration directives ("reduce the propofol infusion") are removed.
 *   - Claims about awareness/recall are removed (EEG cannot establish them);
 *     a limitation may still say awareness cannot be assessed.
 *   - Diagnostic assertions are removed — findings are patterns, not diagnoses.
 *   - Every evidence item must cite numbers that occur in the supplied digest;
 *     unverifiable evidence is dropped, and an alert left with none is dropped.
 *   - Withheld suppression and unreliable depth are respected: evidence that
 *     cites them is dropped and dependent alerts cannot stand on it.
 *   - The AI cannot originate a critical alarm; it is capped at "warning".
 *     Deterministic research alarms are computed and labelled separately.
 */

export type AlertSeverity = "critical" | "warning" | "advisory";
export type AlertConfidence = "low" | "moderate" | "high";

export interface GuardEvidence {
  feature: string;
  value: string;
}

export interface GuardAlert<E extends GuardEvidence = GuardEvidence> {
  id: string;
  severity: AlertSeverity;
  category: string;
  title: string;
  detail: string;
  action: string;
  confidence: AlertConfidence;
  evidence?: E[];
  feedbackInfluence?: unknown;
  tuning?: unknown;
  origin?: "ai_explanatory";
}

export interface GuardInput<A extends GuardAlert = GuardAlert> {
  headline: string;
  alerts: A[];
  depthOfAnaesthesia: string;
  burstSuppression: string;
  seizureRisk: string;
  markerCorrelations: string[];
  pathologyIndicators: { title: string; detail: string; confidence: AlertConfidence; supporting: string[] }[];
  recommendedChecks: string[];
  limitations: string[];
  dataQualityCaveat: string;
}

export interface GuardReport {
  /** Sentences removed for breaching an output restriction. */
  removedStatements: number;
  /** Alerts dropped (no verifiable evidence, or relying on withheld data). */
  droppedAlerts: number;
  /** Evidence items dropped because their numbers were not in the digest. */
  droppedEvidence: number;
  /** Distinct restriction names that fired. */
  rules: string[];
}

/*
 * Treatment-directive detection. A sentence is only a directive when it is
 * phrased as a recommendation (an instruction, a recommending cue such as
 * "consider"/"should", a modal passive such as "should be reduced", or an
 * outcome cue such as "may help") AND it targets a drug or anaesthetic
 * delivery. Co-occurrence alone is not enough: "Depth index fell, indicating
 * deepening anaesthesia" or "lower readings during sedation" are descriptions,
 * not advice, and must survive the guard.
 */
const ACTION_BASE =
  "reduce|decrease|lower|increase|raise|up-?titrate|down-?titrate|titrate|stop|pause|halt|start|commence|give|administer|bolus|wean|deepen|lighten|turn (?:up|down)|cut|withhold|discontinue|switch|add|restart|resume";
const ACTION_GERUND =
  "reducing|decreasing|lowering|increasing|raising|up-?titrating|down-?titrating|titrating|stopping|pausing|halting|starting|commencing|giving|administering|bolusing|weaning|deepening|lightening|turning (?:up|down)|cutting|withholding|discontinuing|switching|adding|restarting|resuming";
const ACTION_PARTICIPLE =
  "reduced|decreased|lowered|increased|raised|up-?titrated|down-?titrated|titrated|stopped|paused|halted|started|commenced|given|administered|bolused|weaned|deepened|lightened|turned (?:up|down)|cut|withheld|discontinued|switched|added|restarted|resumed";
const TREATMENT =
  /\b(infusion|dose|dosing|bolus|propofol|remifentanil|alfentanil|sufentanil|fentanyl|morphine|opioids?|analgesi[ac]\w*|sevoflurane|desflurane|isoflurane|volatile|vapou?r|MAC|anaesthetic|anesthetic|anaesthesia|anesthesia|sedation|sedatives?|midazolam|lorazepam|benzodiazepines?|dexmedetomidine|clonidine|ketamine|thiopent\w*|etomidate|TCI|effect-site|target concentration|antiepileptics?|anticonvulsants?|levetiracetam|phenytoin|valproate|rocuronium|relaxants?)\b/i;
const TREATMENT_SRC = TREATMENT.source.replace(/^\\b\(|\)\\b$/g, "");

/** "Reduce propofol…", "Please lower the sevoflurane MAC", "Deepen anaesthesia". */
const IMPERATIVE = new RegExp(
  `^\\W*(?:please\\s+|now\\s+|then\\s+|immediately\\s+)?(?:${ACTION_BASE})\\s+(?:the\\s+|a\\s+|an\\s+|any\\s+|their\\s+|its\\s+|patient'?s\\s+)?(?:[\\w-]+\\s+)?(?:${TREATMENT_SRC})\\b`,
  "i",
);
/** "Consider increasing…", "We recommend reducing…", "should reduce…". */
const RECOMMENDING_CUE = new RegExp(
  `\\b(?:consider(?:ing)?|recommend(?:s|ed|ing)?|suggest(?:s|ed|ing)?|advis(?:e|es|ed|able)|try|aim to|needs? to|should|must|ought to|may wish to|it (?:may|might|would) be (?:worth|appropriate|reasonable|prudent|advisable)(?:\\s+to)?)\\s+(?:(?!be\\b)\\w+\\s+)?(?:${ACTION_BASE}|${ACTION_GERUND})\\b`,
  "i",
);
/** "The propofol infusion should be reduced" — the treatment is the subject. */
const MODAL_PASSIVE = new RegExp(
  `\\b(?:${TREATMENT_SRC})\\b[^.;:,]{0,40}?\\b(?:should|must|needs? to|ought to|could|may|might|would|can)\\s+(?:\\w+\\s+)?be\\s+(?:${ACTION_PARTICIPLE})\\b`,
  "i",
);
const OUTCOME_CUE =
  "(?:may|might|could|would|should|will) help|(?:is|are|would be) (?:advised|recommended|warranted|indicated|required|appropriate|reasonable)";
/** "Increasing the propofol rate may help", "A reduction in propofol is recommended". */
const OUTCOME_ADVICE = new RegExp(
  `(?:^\\W*(?:${ACTION_GERUND})\\b|\\b(?:reduction|increase|decrease|titration|weaning)\\s+(?:in|of)\\s+(?:the\\s+)?(?:[\\w-]+\\s+)?(?:${TREATMENT_SRC})\\b)[^.;:]*?\\b(?:${OUTCOME_CUE})\\b`,
  "i",
);

const AWARENESS = /\b(awareness|aware|recall)\b/i;
const DIAGNOSIS =
  /\b(diagnos(?:is|ed|e|tic)\s+(?:of|for|is)|confirms?\s+(?:a|an|the)?\s*(?:seizure|stroke|status|hypoxic|encephalopathy|infarct)|is\s+(?:a|an)\s+(?:seizure|stroke|infarct)|has\s+(?:a|an)\s+(?:stroke|seizure|infarct))\b/i;

const NEUTRAL_ACTION =
  "Review the cited metrics against the clinical picture; any treatment change is a clinician decision.";

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isTreatmentDirective(sentence: string): boolean {
  if (!TREATMENT.test(sentence)) return false;
  if (IMPERATIVE.test(sentence)) return true;
  if (RECOMMENDING_CUE.test(sentence)) return true;
  if (MODAL_PASSIVE.test(sentence)) return true;
  return OUTCOME_ADVICE.test(sentence);
}

function breach(sentence: string, allowAwarenessLimitation: boolean): string | null {
  if (isTreatmentDirective(sentence)) return "treatment-directive";
  if (AWARENESS.test(sentence)) {
    const isLimitation = /\b(cannot|can ?not|unable|not possible|does not|doesn't)\b/i.test(sentence);
    if (!(allowAwarenessLimitation && isLimitation)) return "awareness-claim";
  }
  if (DIAGNOSIS.test(sentence)) return "diagnostic-assertion";
  return null;
}

/* ---------------------------------------------------- digest numbers --- */

/** Every finite number in the digest, walked recursively. */
export function digestNumbers(digest: unknown): number[] {
  const out: number[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object")
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(digest, 0);
  return out;
}

/** Numbers written in a free-text value such as "38 %" or "0.42 (42%)". */
export function numbersIn(text: string): number[] {
  return (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

/**
 * A cited number matches the digest if it equals a digest value after the
 * rounding a reader would apply, or the fraction ↔ percent conversion.
 */
export function numberIsSupported(cited: number, pool: number[]): boolean {
  const decimals = (String(cited).split(".")[1] ?? "").length;
  const tol = Math.max(0.5 * 10 ** -decimals, Math.abs(cited) * 0.005);
  for (const d of pool) {
    for (const candidate of [d, d * 100, d / 100, d / 60, d * 60]) {
      if (Math.abs(candidate - cited) <= tol + 1e-9) return true;
    }
  }
  return false;
}

/* ------------------------------------------------- availability gates --- */

interface Availability {
  suppressionWithheld: boolean;
  depthUnreliable: boolean;
  lowQuality: boolean;
}

function readAvailability(digest: unknown): Availability {
  const d = (digest ?? {}) as Record<string, unknown>;
  const supp = (d["suppression"] ?? {}) as Record<string, unknown>;
  const depth = (d["depthIndex"] ?? {}) as Record<string, unknown>;
  const quality = (d["quality"] ?? {}) as Record<string, unknown>;
  const reliable = depth["reliableFraction"];
  const usable = quality["usableFraction"];
  return {
    suppressionWithheld: supp["available"] === false || supp["meanRatioPct"] === null,
    depthUnreliable:
      reliable === null ||
      (typeof reliable === "number" && reliable < 0.5) ||
      depth["latestIsReliable"] === false,
    lowQuality: typeof usable === "number" && usable < 0.5,
  };
}

const SUPPRESSION_FEATURE = /suppress|isoelectric|\bBSR\b|burst/i;
const DEPTH_FEATURE = /depth|COEBIS|\bBIS\b|qCON|consciousness/i;
const DEPTH_CATEGORIES = new Set(["excessive_depth", "inadequate_depth"]);

const SEVERITY_CAP: Record<AlertSeverity, AlertSeverity> = {
  critical: "warning",
  warning: "warning",
  advisory: "advisory",
};

/* ----------------------------------------------------------- the guard --- */

export function guardInterpretation<A extends GuardAlert, T extends GuardInput<A>>(
  parsed: T,
  digest: unknown,
): { output: T; report: GuardReport } {
  const rules = new Set<string>();
  let removedStatements = 0;
  let droppedAlerts = 0;
  let droppedEvidence = 0;
  const avail = readAvailability(digest);
  const pool = digestNumbers(digest);

  const clean = (text: unknown, fallback: string, allowAwarenessLimitation = false): string => {
    if (typeof text !== "string") return fallback;
    const kept: string[] = [];
    for (const s of splitSentences(text)) {
      const rule = breach(s, allowAwarenessLimitation);
      if (rule) {
        rules.add(rule);
        removedStatements++;
      } else kept.push(s);
    }
    return kept.length ? kept.join(" ") : fallback;
  };
  const cleanList = (list: unknown, allowAwarenessLimitation = false): string[] =>
    (Array.isArray(list) ? list : [])
      .map((x) => clean(x, "", allowAwarenessLimitation))
      .filter((x) => x.length > 0);

  const alerts: A[] = [];
  for (const raw of Array.isArray(parsed.alerts) ? parsed.alerts : []) {
    if (!raw || typeof raw !== "object") continue;
    if (avail.suppressionWithheld && raw.category === "burst_suppression") {
      rules.add("suppression-withheld");
      droppedAlerts++;
      continue;
    }
    type E = NonNullable<A["evidence"]>[number];
    const evidence: E[] = [];
    for (const e of Array.isArray(raw.evidence) ? raw.evidence : []) {
      if (!e || typeof e.feature !== "string" || typeof e.value !== "string") {
        droppedEvidence++;
        continue;
      }
      if (avail.suppressionWithheld && SUPPRESSION_FEATURE.test(e.feature)) {
        rules.add("suppression-withheld");
        droppedEvidence++;
        continue;
      }
      if (avail.depthUnreliable && DEPTH_FEATURE.test(e.feature)) {
        rules.add("depth-unreliable");
        droppedEvidence++;
        continue;
      }
      const cited = numbersIn(e.value);
      if (!cited.length || !cited.every((n) => numberIsSupported(n, pool))) {
        rules.add("unverified-number");
        droppedEvidence++;
        continue;
      }
      evidence.push(e);
    }
    if (!evidence.length) {
      rules.add("no-verified-evidence");
      droppedAlerts++;
      continue;
    }
    let confidence = raw.confidence;
    if (avail.lowQuality || (avail.depthUnreliable && DEPTH_CATEGORIES.has(raw.category))) {
      if (confidence !== "low") rules.add("confidence-capped-for-quality");
      confidence = "low";
    }
    const severity = SEVERITY_CAP[raw.severity] ?? "advisory";
    if (severity !== raw.severity) rules.add("ai-cannot-raise-critical");
    const action = clean(raw.action, NEUTRAL_ACTION);
    alerts.push({
      ...raw,
      severity,
      confidence,
      title: clean(raw.title, "Pattern in the measured metrics"),
      detail: clean(raw.detail, "See the cited evidence."),
      action,
      evidence,
      // Feedback no longer shapes alerts; any model-reported influence is void.
      feedbackInfluence: null,
      tuning: null,
      origin: "ai_explanatory",
    } as A);
  }

  const output: T = {
    ...parsed,
    headline: clean(parsed.headline, "AI explanation of the measured metrics."),
    alerts,
    depthOfAnaesthesia: avail.depthUnreliable
      ? `Depth index unreliable in this window (reliability gating); not interpreted. ${clean(parsed.depthOfAnaesthesia, "")}`.trim()
      : clean(parsed.depthOfAnaesthesia, "Not interpreted."),
    burstSuppression: avail.suppressionWithheld
      ? "Suppression was withheld (device amplitude scale not calibrated); it is not interpreted."
      : clean(parsed.burstSuppression, "Not interpreted."),
    seizureRisk: clean(parsed.seizureRisk, "Not interpreted."),
    markerCorrelations: cleanList(parsed.markerCorrelations),
    pathologyIndicators: (Array.isArray(parsed.pathologyIndicators) ? parsed.pathologyIndicators : [])
      .filter((p) => p && typeof p.title === "string")
      .map((p) => ({
        ...p,
        title: clean(p.title, "Pattern"),
        detail: clean(p.detail, "See supporting metrics."),
        // Unvalidated patterns: never presented above low confidence.
        confidence: "low" as const,
        supporting: cleanList(p.supporting),
      })),
    recommendedChecks: cleanList(parsed.recommendedChecks),
    limitations: cleanList(parsed.limitations, true),
    dataQualityCaveat: clean(parsed.dataQualityCaveat, "", true),
  };
  if (output.pathologyIndicators.length) rules.add("pathology-low-confidence");

  return {
    output,
    report: { removedStatements, droppedAlerts, droppedEvidence, rules: [...rules].sort() },
  };
}
