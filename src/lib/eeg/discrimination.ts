/**
 * Discrimination metrics — the standard way depth-of-anaesthesia indices are
 * judged in the literature.
 *
 * Correlation and limits of agreement answer "does the number match the other
 * number". They do not answer the clinical question, which is "when the patient
 * is deeper, does the index say deeper". Prediction probability (Pk, Smith et
 * al.) measures exactly that for ordered clinical states, and is directly
 * comparable across indices measured on different scales. ROC/AUC does the same
 * for a single boundary, such as awake versus adequately anaesthetised.
 *
 * Pk = 1 means the index orders every pair of different states correctly,
 * 0.5 means it is no better than a coin toss, and below 0.5 means it is
 * inverted. Both statistics here handle ties explicitly (a tie counts half),
 * which matters because a bounded 0–100 index produces many of them.
 */

export interface OrdinalObservation {
  /** Index value under test. */
  value: number;
  /** Ordered clinical state: larger = deeper (or any consistent ordering). */
  rank: number;
}

export interface PkResult {
  pk: number | null;
  /** Concordant, discordant and tied pairs across different states. */
  concordant: number;
  discordant: number;
  tied: number;
  /** Observations used. */
  n: number;
  /** Standard error by jackknife over observations, when computable. */
  se: number | null;
}

function pairCounts(obs: OrdinalObservation[]): {
  concordant: number;
  discordant: number;
  tied: number;
} {
  let concordant = 0;
  let discordant = 0;
  let tied = 0;
  for (let i = 0; i < obs.length; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      const a = obs[i]!;
      const b = obs[j]!;
      if (a.rank === b.rank) continue;
      const deeper = a.rank > b.rank ? a : b;
      const lighter = a.rank > b.rank ? b : a;
      if (deeper.value === lighter.value) tied++;
      // A deeper state should carry the LOWER index value.
      else if (deeper.value < lighter.value) concordant++;
      else discordant++;
    }
  }
  return { concordant, discordant, tied };
}

function pkFrom(counts: { concordant: number; discordant: number; tied: number }): number | null {
  const total = counts.concordant + counts.discordant + counts.tied;
  if (!total) return null;
  return (counts.concordant + 0.5 * counts.tied) / total;
}

/**
 * Prediction probability with a jackknife standard error. Values are expected
 * to fall as the state deepens, which is the convention for a depth index.
 */
export function predictionProbability(obs: OrdinalObservation[]): PkResult {
  const usable = obs.filter((o) => Number.isFinite(o.value) && Number.isFinite(o.rank));
  const counts = pairCounts(usable);
  const pk = pkFrom(counts);
  let se: number | null = null;
  if (pk != null && usable.length >= 6 && usable.length <= 400) {
    const jack: number[] = [];
    for (let i = 0; i < usable.length; i++) {
      const sub = usable.filter((_, idx) => idx !== i);
      const v = pkFrom(pairCounts(sub));
      if (v != null) jack.push(v);
    }
    if (jack.length > 1) {
      const m = jack.reduce((a, b) => a + b, 0) / jack.length;
      const varJack =
        ((jack.length - 1) / jack.length) * jack.reduce((s, v) => s + (v - m) ** 2, 0);
      se = Number(Math.sqrt(Math.max(0, varJack)).toFixed(4));
    }
  }
  return {
    pk: pk == null ? null : Number(pk.toFixed(4)),
    concordant: counts.concordant,
    discordant: counts.discordant,
    tied: counts.tied,
    n: usable.length,
    se,
  };
}

export interface RocPoint {
  threshold: number;
  sensitivity: number;
  specificity: number;
}

export interface RocResult {
  /** Area under the curve, 0.5 = chance. */
  auc: number | null;
  nPositive: number;
  nNegative: number;
  /** Threshold maximising sensitivity + specificity − 1. */
  bestThreshold: number | null;
  bestYouden: number | null;
  curve: RocPoint[];
}

/**
 * ROC for "index below threshold indicates the positive (deeper) class", which
 * is how a depth index is used clinically. Ties contribute half, so the AUC
 * equals the Mann-Whitney statistic.
 */
export function rocAnalysis(
  values: { value: number; positive: boolean }[],
): RocResult {
  const usable = values.filter((v) => Number.isFinite(v.value));
  const pos = usable.filter((v) => v.positive).map((v) => v.value);
  const neg = usable.filter((v) => !v.positive).map((v) => v.value);
  if (!pos.length || !neg.length) {
    return { auc: null, nPositive: pos.length, nNegative: neg.length, bestThreshold: null, bestYouden: null, curve: [] };
  }
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p < n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  const auc = wins / (pos.length * neg.length);

  const thresholds = [...new Set(usable.map((v) => v.value))].sort((a, b) => a - b);
  const curve: RocPoint[] = thresholds.map((threshold) => {
    const tp = pos.filter((v) => v <= threshold).length;
    const fp = neg.filter((v) => v <= threshold).length;
    return {
      threshold,
      sensitivity: Number((tp / pos.length).toFixed(4)),
      specificity: Number((1 - fp / neg.length).toFixed(4)),
    };
  });
  let bestThreshold: number | null = null;
  let bestYouden: number | null = null;
  for (const pt of curve) {
    const youden = pt.sensitivity + pt.specificity - 1;
    if (bestYouden == null || youden > bestYouden) {
      bestYouden = Number(youden.toFixed(4));
      bestThreshold = pt.threshold;
    }
  }
  return {
    auc: Number(auc.toFixed(4)),
    nPositive: pos.length,
    nNegative: neg.length,
    bestThreshold,
    bestYouden,
    curve,
  };
}

/** "Pk 0.84 (n = 120)" style label. */
export function describePk(result: PkResult): string {
  if (result.pk == null) return "Not enough differing clinical states to measure discrimination.";
  const quality =
    result.pk >= 0.9
      ? "excellent"
      : result.pk >= 0.8
        ? "good"
        : result.pk >= 0.7
          ? "moderate"
          : "poor";
  const ci = result.se == null ? "" : ` ± ${(1.96 * result.se).toFixed(3)}`;
  return `Pk ${result.pk.toFixed(3)}${ci} across ${result.n} readings — ${quality} separation of clinical states.`;
}
