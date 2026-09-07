# Stop the heavy model runs from timing out

## The problem (confirmed)

When you press "Refit now" or open one of the heaviest model screens, the whole
calculation is done while the page waits. On the live site that work sometimes
runs past the time the server is allowed to spend on one request, and you get a
failed or blank page instead of a result. It happened seven times in one hour.

The two heaviest runs are the full model refit (it loads up to 200,000 readings,
then cross-validates every setup one after another) and the headband pool refit.

## What to change

1. **Turn "Refit now" into a queued job, not a wait.**
   Pressing the button records a request and returns straight away with
   "queued". The screen then shows progress and swaps in the result when it is
   ready — the same pattern the analysis screens already use.

2. **Do the work one slice at a time.**
   Each background pass handles a single setup (lineage) and a bounded slice of
   readings, records what it finished, and leaves the rest for the next pass.
   A run that reaches its time budget stops cleanly and resumes rather than
   failing.

3. **Keep a hard ceiling per pass.**
   Cap readings loaded per pass and setups refitted per pass, chosen so a pass
   comfortably finishes inside the allowed time even on the largest pool.

4. **Show honest progress.**
   The refit panel says which setup is being worked out, how many are left, and
   when the last one finished — never a spinner that can silently die.

## Technical notes

- Extend the existing `analysis_job_state` / `coebis_refit_state` lease pattern
  with a per-lineage cursor so a run resumes where it stopped.
- `runRefitNow` (`src/lib/eeg/coebis-refit.functions.ts`) becomes an enqueue:
  set the state row to `queued`, return current progress.
- `runRefitForUser` (`src/lib/eeg/coebis-refit.server.ts`) gains a
  `maxLineages`/`maxPoints`/deadline budget and returns a `resumeFrom` cursor.
- Drive the passes from the existing cron endpoint
  (`src/routes/api/public/hooks/coebis-refit.ts`) plus a short client poll while
  a run is queued.
- Same treatment for `runHeadbandPoolRefit` in `headband-pool.server.ts`.

## Not in scope

No change to how a model is graded or promoted — the accuracy bar and the
held-out grading stay exactly as they are.
