/**
 * Phase mapping for the Cambridge propofol arc (browser-safe constants).
 *
 * The volunteers were recorded in four stepped blocks; those blocks stand in
 * for the phases of a case. The mapping is stated rather than assumed, and
 * the deepest block is moderate sedation, not anaesthesia.
 */
export type CasePhase = "baseline" | "induction" | "maintenance" | "emergence";

export const PHASE_ORDER: CasePhase[] = ["baseline", "induction", "maintenance", "emergence"];

export const PHASE_TEXT: Record<CasePhase, { label: string; detail: string }> = {
  baseline: { label: "Baseline", detail: "No drug, volunteer awake" },
  induction: { label: "Induction", detail: "Propofol rising to 0.6 \u00b5g/ml" },
  maintenance: { label: "Maintenance", detail: "Peak target 1.2 \u00b5g/ml held" },
  emergence: { label: "Emergence", detail: "Drug withdrawn, recovering" },
};

/** The phase a recorded drug-level block stands for. */
export function phaseOfLevel(level: string | null): CasePhase | null {
  switch (level) {
    case "baseline":
      return "baseline";
    case "mild":
      return "induction";
    case "moderate":
      return "maintenance";
    case "recovery":
      return "emergence";
    default:
      return null;
  }
}
