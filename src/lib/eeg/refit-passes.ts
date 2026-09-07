/**
 * Drive a refit to completion as a series of small passes.
 *
 * Each pass is one bounded request: one acquisition setup and a capped slice
 * of readings, so the server always finishes inside the time it is allowed.
 * A setup already refitted in an earlier pass is skipped by its data
 * fingerprint, so repeating the call resumes rather than repeats.
 */

export interface RefitPassResult {
  status: string;
  summary: string;
  lineagesRefitted: number;
  modelsPromoted: number;
  validatedPoints: number;
  remaining: number;
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
 * Returns the totals across every pass.
 */
export async function runRefitToCompletion(
  runPass: () => Promise<RefitPassResult>,
  onProgress?: (p: RefitProgress) => void,
  maxPasses = MAX_PASSES,
): Promise<RefitPassResult> {
  let last: RefitPassResult | null = null;
  let lineagesRefitted = 0;
  let modelsPromoted = 0;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const result = await runPass();
    last = result;
    lineagesRefitted += result.lineagesRefitted;
    modelsPromoted += result.modelsPromoted;
    onProgress?.({
      pass,
      remaining: result.remaining,
      lineagesRefitted,
      modelsPromoted,
    });
    if (result.status === "failed" || result.done || result.remaining <= 0) break;
  }

  if (!last) throw new Error("The refit did not run.");
  return { ...last, lineagesRefitted, modelsPromoted };
}
