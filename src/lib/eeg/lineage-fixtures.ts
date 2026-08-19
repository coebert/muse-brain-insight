/**
 * Randomised lineage fixtures.
 *
 * Compatibility between the setup a model was fitted on and the setup now
 * streaming is decided by a handful of interacting rules (sample rate floor,
 * hemispheric coverage, how many fitted positions are missing, device identity).
 * Hand-written cases only ever cover the combinations someone thought of, so
 * these generators walk the space instead: every fixture carries the category
 * it is expected to fall into, worked out from the clinical rules rather than
 * from the implementation, so a test can stress compareLineage, the COEBIS gate
 * and the seizure gate against thousands of montage pairs.
 *
 * The generator is seeded, so a failing run reproduces exactly.
 */
import {
  ANALYSIS_CHANNELS,
  CHANNEL_SIDE,
  type AnalysisChannel,
  type DeviceProfile,
} from "./device-profile";
import {
  MIN_USABLE_SAMPLE_RATE,
  lineageFromProfile,
  type DataLineage,
  type LineageMatch,
} from "./model-lineage";

/* ------------------------------------------------------------------ */
/* Seeded randomness                                                   */
/* ------------------------------------------------------------------ */

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(pTrue?: number): boolean;
}

/** mulberry32 — small, fast, and stable across runs for a given seed. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    bool: (pTrue = 0.5) => next() < pTrue,
  };
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

/** Native rates that clear the analysis band. */
export const USABLE_RATES = [128, 200, 220, 250, 256, 300, 500, 512] as const;
/** Native rates that cannot reconstruct the 45 Hz analysis band. */
export const UNUSABLE_RATES = [32, 50, 60, 100, 120, 127] as const;

const DEVICE_IDS = [
  "muse-2",
  "focuscalm",
  "frontal-pair",
  "csv-replay",
  "serial-strip",
  "lsl-stream",
] as const;

function canonical(channels: AnalysisChannel[]): AnalysisChannel[] {
  return ANALYSIS_CHANNELS.filter((c) => channels.includes(c));
}

/** Every non-empty subset of the canonical montage, in canonical order. */
export function allMontages(): AnalysisChannel[][] {
  const out: AnalysisChannel[][] = [];
  for (let mask = 1; mask < 1 << ANALYSIS_CHANNELS.length; mask += 1) {
    out.push(ANALYSIS_CHANNELS.filter((_, i) => (mask >> i) & 1));
  }
  return out;
}

export function randomMontage(rng: Rng, opts: { allowEmpty?: boolean } = {}): AnalysisChannel[] {
  const montages = allMontages();
  if (opts.allowEmpty && rng.bool(0.08)) return [];
  return rng.pick(montages);
}

export function randomLineage(
  rng: Rng,
  opts: {
    channels?: AnalysisChannel[];
    sampleRate?: number;
    deviceId?: string;
    usableRate?: boolean;
    allowEmpty?: boolean;
  } = {},
): DataLineage {
  const deviceId = opts.deviceId ?? rng.pick(DEVICE_IDS);
  const channels = canonical(opts.channels ?? randomMontage(rng, { allowEmpty: opts.allowEmpty }));
  const sampleRate =
    opts.sampleRate ??
    (opts.usableRate === false ? rng.pick(UNUSABLE_RATES) : rng.pick(USABLE_RATES));
  return {
    deviceId,
    deviceLabel: `${deviceId} (${channels.length || "no"} ch)`,
    transport: deviceId === "muse-2" ? "ble" : "ingest",
    channels,
    sampleRate,
  };
}

/** A device profile that streams exactly this lineage, for the seizure gate. */
export function profileFromLineage(l: DataLineage): DeviceProfile {
  return {
    id: l.deviceId,
    label: l.deviceLabel,
    transport: l.transport,
    channels: [...l.channels],
    sampleRate: l.sampleRate,
    sourceLabels: {},
    note: "Generated fixture montage.",
    capabilities: { battery: false, reconnect: false, contactSensing: false },
  };
}

/* ------------------------------------------------------------------ */
/* Expectation oracle                                                  */
/* ------------------------------------------------------------------ */

function coversSide(channels: AnalysisChannel[], side: "left" | "right"): boolean {
  return channels.some((c) => CHANNEL_SIDE[c] === side);
}

/**
 * The clinical rules, restated independently of the implementation:
 * an unusable rate or an empty montage is never workable; losing a hemisphere
 * the model needs, or more than one fitted position, breaks the fit; losing one
 * position is a reduced run; otherwise it is the same measurement, exact when
 * the stored key would be identical.
 */
export function expectedMatch(fitted: DataLineage, current: DataLineage): LineageMatch {
  if (current.sampleRate < MIN_USABLE_SAMPLE_RATE) return "incompatible";
  if (current.channels.length === 0) return "incompatible";
  const missing = fitted.channels.filter((c) => !current.channels.includes(c));
  const lostSide = (["left", "right"] as const).some(
    (side) => coversSide(fitted.channels, side) && !coversSide(current.channels, side),
  );
  if (lostSide) return "incompatible";
  if (missing.length > 1) return "incompatible";
  if (missing.length === 1) return "reduced";
  const sameKey =
    fitted.deviceId === current.deviceId &&
    Math.round(fitted.sampleRate) === Math.round(current.sampleRate) &&
    canonical(fitted.channels).join("-") === canonical(current.channels).join("-");
  return sameKey ? "exact" : "compatible";
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export interface LineageFixture {
  /** Human-readable name, printed on failure. */
  name: string;
  fitted: DataLineage;
  current: DataLineage;
  /** Profile streaming `current`, for detector gating. */
  profile: DeviceProfile;
  expected: LineageMatch;
  /** True when the pair should still drive a COEBIS index (possibly caveated). */
  coebisUsable: boolean;
}

function fixture(name: string, fitted: DataLineage, current: DataLineage): LineageFixture {
  const expected = expectedMatch(fitted, current);
  return {
    name,
    fitted,
    current,
    profile: profileFromLineage(current),
    expected,
    coebisUsable: expected !== "incompatible",
  };
}

/** A pair drawn to land on the compatible side of the rules. */
export function compatibleFixture(rng: Rng, index = 0): LineageFixture {
  const fittedChannels = randomMontage(rng);
  const variant = rng.int(4);
  let currentChannels = [...fittedChannels];
  if (variant === 1) {
    // Add a position the model never saw — must be ignored, not penalised.
    const spare = ANALYSIS_CHANNELS.filter((c) => !fittedChannels.includes(c));
    if (spare.length) currentChannels = canonical([...fittedChannels, rng.pick(spare)]);
  } else if (variant === 2 && fittedChannels.length > 2) {
    // Drop one fitted position without losing a hemisphere: a reduced run.
    const droppable = fittedChannels.filter((c) =>
      fittedChannels.some((o) => o !== c && CHANNEL_SIDE[o] === CHANNEL_SIDE[c]),
    );
    if (droppable.length) {
      const drop = rng.pick(droppable);
      currentChannels = fittedChannels.filter((c) => c !== drop);
    }
  }
  const sameDevice = variant === 3 ? true : rng.bool(0.4);
  const fitted = randomLineage(rng, { channels: fittedChannels });
  const current = randomLineage(rng, {
    channels: currentChannels,
    deviceId: sameDevice ? fitted.deviceId : undefined,
    sampleRate: sameDevice && variant === 3 ? fitted.sampleRate : undefined,
  });
  return fixture(`compatible#${index}`, fitted, current);
}

/** A pair drawn to break at least one of the rules. */
export function incompatibleFixture(rng: Rng, index = 0): LineageFixture {
  const kind = rng.int(4);
  const fittedChannels =
    kind === 1
      ? canonical([...ANALYSIS_CHANNELS])
      : randomMontage(rng).length > 1
        ? randomMontage(rng)
        : canonical([...ANALYSIS_CHANNELS]);
  const fitted = randomLineage(rng, { channels: fittedChannels });

  let current: DataLineage;
  if (kind === 0) {
    // Rate below the analysis band.
    current = randomLineage(rng, { channels: fittedChannels, usableRate: false });
  } else if (kind === 1) {
    // One hemisphere only, against a bilateral fit.
    const side = rng.pick(["left", "right"] as const);
    current = randomLineage(rng, {
      channels: ANALYSIS_CHANNELS.filter((c) => CHANNEL_SIDE[c] === side),
    });
  } else if (kind === 2) {
    // No electrode mapped at all.
    current = randomLineage(rng, { channels: [] });
  } else {
    // More than one fitted position absent.
    const keep = fittedChannels.slice(0, Math.max(0, fittedChannels.length - 2));
    current = randomLineage(rng, {
      channels: keep.length ? keep : [rng.pick(ANALYSIS_CHANNELS)],
    });
  }
  return fixture(`incompatible#${index}`, fitted, current);
}

/**
 * A mixed batch: roughly half drawn to be workable and half to break, plus
 * fully unconstrained pairs so combinations nobody anticipated still appear.
 */
export function generateLineageFixtures(count: number, seed = 20260819): LineageFixture[] {
  const rng = makeRng(seed);
  const out: LineageFixture[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rng.next();
    if (roll < 0.4) out.push(compatibleFixture(rng, i));
    else if (roll < 0.8) out.push(incompatibleFixture(rng, i));
    else {
      const fitted = randomLineage(rng, { allowEmpty: true });
      const current = randomLineage(rng, {
        allowEmpty: true,
        usableRate: rng.bool(0.8) ? undefined : false,
      });
      out.push(fixture(`random#${i}`, fitted, current));
    }
  }
  return out;
}

/** Exhaustive montage-by-montage sweep at a fixed rate, for coverage of every subset pair. */
export function exhaustiveMontageFixtures(
  opts: { fittedRate?: number; currentRate?: number; sameDevice?: boolean } = {},
): LineageFixture[] {
  const fittedRate = opts.fittedRate ?? 256;
  const currentRate = opts.currentRate ?? 256;
  const out: LineageFixture[] = [];
  for (const fittedChannels of allMontages()) {
    for (const currentChannels of allMontages()) {
      const fitted: DataLineage = {
        deviceId: "fitted-device",
        deviceLabel: "fitted-device",
        transport: "ingest",
        channels: fittedChannels,
        sampleRate: fittedRate,
      };
      const currentDeviceId = opts.sameDevice === false ? "current-device" : "fitted-device";
      const current: DataLineage = {
        deviceId: currentDeviceId,
        deviceLabel: currentDeviceId,
        transport: "ingest",
        channels: currentChannels,
        sampleRate: currentRate,
      };
      out.push(
        fixture(`${fittedChannels.join("+")} -> ${currentChannels.join("+")}`, fitted, current),
      );
    }
  }
  return out;
}

/** Profiles for seizure-gate stress: montage and rate combinations only. */
export function seizureGateFixtures(): DeviceProfile[] {
  const out: DeviceProfile[] = [];
  for (const channels of allMontages()) {
    for (const rate of [...UNUSABLE_RATES.slice(0, 2), ...USABLE_RATES]) {
      out.push(
        profileFromLineage({
          deviceId: `gen-${channels.length}ch-${rate}`,
          deviceLabel: `${channels.join("+")} @ ${rate} Hz`,
          transport: "ingest",
          channels,
          sampleRate: rate,
        }),
      );
    }
  }
  return out;
}

/** Convenience: lineage for a generated profile. */
export function fixtureLineage(p: DeviceProfile): DataLineage {
  return lineageFromProfile(p);
}
