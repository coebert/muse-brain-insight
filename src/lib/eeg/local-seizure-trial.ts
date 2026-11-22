/** Interpreter for frontal eight-second JSON checkpoints from the research seizure study. */
const COLUMNS = 140;
const WINDOW_COUNT = 24;
const TREE_KEYS = [
  "is_leaf",
  "feature_idx",
  "num_threshold",
  "missing_go_to_left",
  "left",
  "right",
  "value",
] as const;
type Tree = Record<(typeof TREE_KEYS)[number], number[]>;
type Policy = { threshold: number; persistence: number; release_ratio: number };
export type AlarmMode = "lower_alarm" | "sensitivity_priority";
export type SeizureCheckpoint = {
  baseline: number;
  trees: Tree[];
  calibration: [number, number];
  policies: Record<AlarmMode, Policy>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteVector(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}
function validTree(value: unknown): value is Tree {
  if (!isRecord(value) || !Array.isArray(value["is_leaf"])) return false;
  const n = value["is_leaf"].length;
  if (n < 1 || n > 127 || !TREE_KEYS.every((k) => finiteVector(value[k], n))) return false;
  const t = value as Tree;
  for (let i = 0; i < n; i++) {
    if (![0, 1].includes(t.is_leaf[i]!) || ![0, 1].includes(t.missing_go_to_left[i]!)) return false;
    if (t.is_leaf[i] === 1) continue;
    const col = t.feature_idx[i]!;
    if (!Number.isInteger(col) || col < 0 || col >= COLUMNS) return false;
    // scikit-learn numbers each child after its parent. This also rejects cyclic input.
    if (
      ![t.left[i]!, t.right[i]!].every((child) => Number.isInteger(child) && child > i && child < n)
    )
      return false;
  }
  return true;
}
function readPolicy(v: unknown): Policy | null {
  if (!isRecord(v)) return null;
  const p = v["persistence"],
    t = v["threshold"],
    r = v["release_ratio"] ?? 1;
  if (
    typeof p !== "number" ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > WINDOW_COUNT ||
    typeof t !== "number" ||
    !(t > 0 && t <= 1) ||
    typeof r !== "number" ||
    !(r > 0 && r <= 1)
  )
    return null;
  return { threshold: t, release_ratio: r, persistence: p };
}
export function parseSeizureCheckpoint(source: string): SeizureCheckpoint {
  if (source.length > 1_000_000)
    throw new Error("Choose an extracted frontal model JSON file under 1 MB.");
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new Error("This file could not be read as JSON.");
  }
  const invalid =
    "Choose boston-frontal.json or boston-frontal-expanded.json from the seizure research package.";
  if (
    !isRecord(data) ||
    data["version"] !== 1 ||
    data["montage"] !== "frontal" ||
    data["step_seconds"] !== 8 ||
    data["columns"] !== COLUMNS ||
    typeof data["baseline"] !== "number" ||
    !Number.isFinite(data["baseline"]) ||
    !Array.isArray(data["trees"]) ||
    data["trees"].length < 1 ||
    data["trees"].length > 256 ||
    !data["trees"].every(validTree) ||
    !finiteVector(data["calibration"], 2) ||
    !isRecord(data["policies"])
  )
    throw new Error(invalid);
  const lower = readPolicy(data["policies"]["lower_alarm"]),
    sensitive = readPolicy(data["policies"]["sensitivity_priority"]);
  if (!lower || !sensitive) throw new Error(invalid);
  return {
    baseline: data["baseline"],
    trees: data["trees"],
    calibration: [data["calibration"][0]!, data["calibration"][1]!],
    policies: { lower_alarm: lower, sensitivity_priority: sensitive },
  };
}
export function decodeSeizureTrialFixture(fixture: { data: string; usable: boolean[] }) {
  const bytes = Uint8Array.from(atob(fixture.data), (c) => c.charCodeAt(0));
  if (bytes.length !== WINDOW_COUNT * COLUMNS * 4 || fixture.usable.length !== WINDOW_COUNT) {
    throw new Error("The synthetic recording could not be loaded.");
  }
  const view = new DataView(bytes.buffer);
  return Array.from({ length: WINDOW_COUNT }, (_, i) =>
    fixture.usable[i]
      ? Array.from({ length: COLUMNS }, (_, j) => view.getFloat32(4 * (i * COLUMNS + j), true))
      : null,
  );
}
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
export function runSeizureTrial(
  model: SeizureCheckpoint,
  rows: (number[] | null)[],
  mode: AlarmMode,
) {
  const scores = rows.map((row) => {
    if (!row) return null;
    if (row.length !== COLUMNS)
      throw new Error("The feature vector does not match the selected checkpoint.");
    let value = model.baseline;
    for (const tree of model.trees) {
      let node = 0;
      while (!tree.is_leaf[node]) {
        const x = row[tree.feature_idx[node]!]!;
        const goLeft = Number.isNaN(x)
          ? tree.missing_go_to_left[node]
          : x <= tree.num_threshold[node]!;
        node = goLeft ? tree.left[node]! : tree.right[node]!;
      }
      value += tree.value[node]!;
    }
    if (!Number.isFinite(value)) throw new Error("The model produced a non-finite score.");
    const raw = Math.min(1 - 1e-7, Math.max(1e-7, sigmoid(value)));
    const calibrated = model.calibration[0] * Math.log(raw / (1 - raw)) + model.calibration[1];
    if (!Number.isFinite(calibrated))
      throw new Error("The model calibration produced a non-finite score.");
    return sigmoid(calibrated);
  });
  const policy = model.policies[mode],
    alarms: number[] = [];
  let streak = 0,
    active = false;
  for (const [i, score] of scores.entries()) {
    streak = score !== null && score >= policy.threshold ? streak + 1 : 0;
    const next: boolean =
      streak >= policy.persistence ||
      (active && score !== null && score >= policy.threshold * policy.release_ratio);
    if (next && !active) alarms.push((i + 1) * 8);
    active = next;
  }
  return { scores, alarms };
}
