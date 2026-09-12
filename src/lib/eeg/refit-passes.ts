/**
 * Drive a refit to completion as a series of small passes.
 *
 * Each pass is one bounded request: one acquisition setup and a capped slice
 * of readings, so the server always finishes inside the time it is allowed.
 * A setup already worked through in an earlier pass is named back to the next
 * pass so it is left out, which means a setup that is too small to fit can
 * never be picked over and over while the rest are never reached.
 */

export interface RefitPassResult {
  status: string;
  summary: string;
  lineagesRefitted: number;
  modelsPromoted: number;
  validatedPoints: number;
  remaining: number;
  /** Setups this pass worked through, excluded from the next pass. */
  processed?: string[];
  done: boolean;
  error: string | null;
}

/** Hard ceiling on passes per button press, so nothing can loop forever. */
export const MAX_PASSES = 8;

export interface RefitProgress {
  pass: number;
  remaining: number;
  lineagesRefitted: number;
  modelsPromoted: number;
}

/**
 * Repeat `runPass` until nothing is left, a pass fails, or the ceiling is hit.
 * A pass that gets through no setup at all stops the loop rather than
 * repeating itself, and says so instead of reporting success.
 */
export async function runRefitToCompletion(
  runPass: (skipLineages: string[]) => Promise<RefitPassResult>,
  onProgress?: (p: RefitProgress) => void,
  maxPasses = MAX_PASSES,
): Promise<RefitPassResult> {
  let last: RefitPassResult | null = null;
  let lineagesRefitted = 0;
  let modelsPromoted = 0;
  const done = new Set<string>();

  for (let pass = 1; pass <= maxPasses; pass++) {
    const result = await runPass([...done]);
    last = result;
    lineagesRefitted += result.lineagesRefitted;
    modelsPromoted += result.modelsPromoted;
    for (const key of result.processed ?? []) done.add(key);
    onProgress?.({
      pass,
      remaining: result.remaining,
      lineagesRefitted,
      modelsPromoted,
    });
    if (result.status === "failed" || result.done || result.remaining <= 0) break;

    // Nothing got through this time: repeating the same request would only
    // produce the same empty pass, so stop and report it plainly.
    if (result.lineagesRefitted === 0) {
      return {
        ...result,
        lineagesRefitted,
        modelsPromoted,
        status: lineagesRefitted > 0 ? result.status : "stalled",
        summary:
          lineagesRefitted > 0
            ? `${result.summary} ${result.remaining} setup(s) could not be worked through this time.`
            : "The refit could not get through any setup. Nothing was changed.",
      };
    }
  }

  if (!last) throw new Error("The refit did not run.");
  return { ...last, lineagesRefitted, modelsPromoted };
}
