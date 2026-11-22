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

import {
  DESCRIPTOR_ONLY_TEMPLATES,
  RESEARCH_SCORE_LABEL,
  RESEARCH_SCORE_NOTE,
  descriptorOnlyText,
  descriptorPolicy,
  impliesDepthOrSedation,
  type BlockadeContext,
} from "@/lib/eeg/descriptor-only";

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
  /** True when depth/awareness prose was replaced by the descriptor-only templates. */
  descriptorOnly?: boolean;
  /** The blockade context that decided the policy. */
  descriptorContext?: BlockadeContext;
  /** Why the context did or did not support a depth statement. */
  descriptorReason?: string;
  /** Wording that must travel with any experimental score in an export. */
  researchScoreNote?: string;
  /** Short label for an experimental score; never a clinical depth label. */
  researchScoreLabel?: string;
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

/*
 * Instruction detection. An action verb in the base (imperative) form at the
 * start of a clause — sentence start, after a comma/semicolon/colon/dash, after
 * "then/and/or/otherwise", or after a leading "If…/When…/Once…" condition —
 * whose object is a treatment. The object may carry determiners, doses and
 * delivery words ("the rate of the propofol infusion", "20 mg of propofol") and
 * at most one other free word, so "lower readings during sedation" stays a
 * description while "If BIS < 40, reduce the rate of propofol" is an instruction.
 */
const OBJECT_MOD =
  "the|a|an|any|their|its|your|this|that|current|patient'?s|of|to|by|rate|dose|dosing|infusion|bolus|concentration|target|effect-site|end-tidal|inspired|background|maintenance|delivered|pump|vapori[sz]er|dial|setting|level|amount|\\d+(?:\\.\\d+)?\\s*(?:mg\\/kg|mcg\\/kg|mg|mcg|µg|ug|ml|mL|%)?";
/** Delivery words that count as a treatment object only straight after an instruction verb. */
const DELIVERY_OBJECT = "rate|dose|dosing|infusion|bolus|concentration|target|pump|vapori[sz]er|dial|setting";
const INSTRUCTION_OBJECT = `(?:(?:${OBJECT_MOD})\\s+){0,5}(?:[\\w-]+\\s+)?(?:(?:${OBJECT_MOD})\\s+){0,4}(?:${TREATMENT_SRC}|${DELIVERY_OBJECT})\\b`;
const CLAUSE_START =
  "(?:^\\W*|[,;:\\u2013\\u2014]\\s*|\\s-\\s+|\\b(?:then|and|or|otherwise)\\s+|^\\W*(?:if|when|whenever|once|unless|until|should)\\b[^.;:]{0,80}?\\s)";
/** "…is lower during sedation" uses the verb as a comparative adjective, not an instruction. */
const NOT_COMPARATIVE =
  "(?<!\\b(?:is|are|was|were|be|been|being|remain|remains|remained|become|becomes|became|stay|stays|stayed|appear|appears|appeared|seem|seems|seemed|get|gets|got|much|slightly|even|far|no|any|significantly|markedly|somewhat)\\s)";
const IMPERATIVE = new RegExp(
  `${CLAUSE_START}${NOT_COMPARATIVE}(?:please\\s+|now\\s+|then\\s+|immediately\\s+|promptly\\s+|gently\\s+|slowly\\s+)?(?:${ACTION_BASE})\\s+${INSTRUCTION_OBJECT}`,
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
  if (IMPERATIVE.test(sentence)) return true;
  if (!TREATMENT.test(sentence)) return false;
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
  const policy = descriptorPolicy(digest);

  /*
   * Descriptor-only is a deterministic structured output, not a sentence
   * filter. Every free-text field is replaced with a fixed template and every
   * alert is dropped, so a model cannot phrase a patient-state claim in a way
   * the regular expressions miss. The same shape is applied to cached results
   * by sanitizeCachedInterpretation.
   */
  if (policy.descriptorOnly) {
    const output: T = {
      ...parsed,
      headline: DESCRIPTOR_ONLY_TEMPLATES.headline,
      alerts: [],
      depthOfAnaesthesia: DESCRIPTOR_ONLY_TEMPLATES.depth,
      burstSuppression: DESCRIPTOR_ONLY_TEMPLATES.measured,
      seizureRisk: DESCRIPTOR_ONLY_TEMPLATES.measured,
      markerCorrelations: [],
      pathologyIndicators: [],
      recommendedChecks: [DESCRIPTOR_ONLY_TEMPLATES.recommendation],
      limitations: [DESCRIPTOR_ONLY_TEMPLATES.awareness],
      dataQualityCaveat: "",
      descriptorOnly: true,
      descriptorContext: policy.context,
      descriptorReason: policy.reason,
      researchScoreNote: RESEARCH_SCORE_NOTE,
      researchScoreLabel: RESEARCH_SCORE_LABEL,
    };
    return {
      output,
      report: {
        removedStatements: 1,
        droppedAlerts: Array.isArray(parsed.alerts) ? parsed.alerts.length : 0,
        droppedEvidence: 0,
        rules: ["descriptor-only"],
      },
    };
  }

  const clean = (text: unknown, fallback: string, allowAwarenessLimitation = false): string => {
    if (typeof text !== "string") return fallback;
    const kept: string[] = [];
    for (const s of splitSentences(text)) {
      const rule = breach(s, allowAwarenessLimitation);
      if (rule) {
        rules.add(rule);
        removedStatements++;
      } else if (impliesDepthOrSedation(s)) {
        // Patient-state and sedation-adequacy assertions are never supported
        // by this signal, whether or not the depth index looked reliable.
        rules.add("descriptor-only");
        removedStatements++;
      } else kept.push(s);
    }
    const joined = kept.join(" ");
    const cleaned = descriptorOnlyText(joined, "", policy.descriptorOnly);
    if (cleaned !== joined) {
      rules.add("descriptor-only");
      removedStatements++;
    }
    return cleaned || fallback;
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
    // A withheld context cannot support an alert about the depth plane or
    // awareness, however confidently the model phrased it.
    if (
      policy.descriptorOnly &&
      (DEPTH_CATEGORIES.has(raw.category) ||
        impliesDepthOrSedation(raw.title) ||
        impliesDepthOrSedation(raw.detail) ||
        impliesDepthOrSedation(raw.action))
    ) {
      rules.add("descriptor-only");
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
      detail: clean(
        raw.detail,
        policy.descriptorOnly ? DESCRIPTOR_ONLY_TEMPLATES.alertDetail : "See the cited evidence.",
      ),
      action,
      evidence,
      // Feedback no longer shapes alerts; any model-reported influence is void.
      feedbackInfluence: null,
      tuning: null,
      origin: "ai_explanatory",
    } as A);
  }

  const limitations = cleanList(parsed.limitations, true);
  if (
    policy.descriptorOnly &&
    !limitations.some((line) => /awareness cannot be assessed/i.test(line))
  ) {
    limitations.push(DESCRIPTOR_ONLY_TEMPLATES.awareness);
  }

  const output: T = {
    ...parsed,
    headline: policy.descriptorOnly
      ? DESCRIPTOR_ONLY_TEMPLATES.headline
      : clean(parsed.headline, "AI explanation of the measured metrics."),
    alerts,
    depthOfAnaesthesia: policy.descriptorOnly
      ? DESCRIPTOR_ONLY_TEMPLATES.depth
      : avail.depthUnreliable
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
    recommendedChecks: policy.descriptorOnly
      ? [DESCRIPTOR_ONLY_TEMPLATES.recommendation]
      : cleanList(parsed.recommendedChecks),
    limitations,
    dataQualityCaveat: clean(parsed.dataQualityCaveat, "", true),
    descriptorOnly: policy.descriptorOnly,
    descriptorContext: policy.context,
    descriptorReason: policy.reason,
    researchScoreNote: RESEARCH_SCORE_NOTE,
    researchScoreLabel: RESEARCH_SCORE_LABEL,
  };
  if (policy.descriptorOnly) rules.add("descriptor-only");
  if (output.pathologyIndicators.length) rules.add("pathology-low-confidence");

  return {
    output,
    report: { removedStatements, droppedAlerts, droppedEvidence, rules: [...rules].sort() },
  };
}

/**
 * Last line of defence for a stored or cached interpretation.
 *
 * A result is trusted only when it explicitly says descriptorOnly === false,
 * i.e. it was produced against a fully evidenced context. Anything else —
 * including a record written before this field existed — is replaced with the
 * deterministic descriptor-only shape before it can be rendered.
 */
export function sanitizeCachedInterpretation<T extends Partial<GuardInput>>(result: T): T {
  if (result.descriptorOnly === false) return result;
  return {
    ...result,
    headline: DESCRIPTOR_ONLY_TEMPLATES.headline,
    alerts: [],
    depthOfAnaesthesia: DESCRIPTOR_ONLY_TEMPLATES.depth,
    burstSuppression: DESCRIPTOR_ONLY_TEMPLATES.measured,
    seizureRisk: DESCRIPTOR_ONLY_TEMPLATES.measured,
    markerCorrelations: [],
    pathologyIndicators: [],
    recommendedChecks: [DESCRIPTOR_ONLY_TEMPLATES.recommendation],
    limitations: [DESCRIPTOR_ONLY_TEMPLATES.awareness],
    dataQualityCaveat: "",
    descriptorOnly: true,
    descriptorContext: result.descriptorContext ?? "missing",
    descriptorReason:
      result.descriptorReason ??
      "cached interpretation without a documented blockade-absence context",
    researchScoreNote: RESEARCH_SCORE_NOTE,
    researchScoreLabel: RESEARCH_SCORE_LABEL,
  } as T;
}
