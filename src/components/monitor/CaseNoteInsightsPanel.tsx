import { useServerFn } from "@tanstack/react-start";
import { Lightbulb, NotebookPen, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { mineCaseNotes, type CaseNoteInsights } from "@/lib/eeg/case-notes.functions";
import { cn } from "@/lib/utils";

const STRENGTH_STYLES: Record<string, string> = {
  emerging: "bg-muted text-muted-foreground",
  moderate: "bg-caution/15 text-caution",
  strong: "bg-signal/15 text-signal",
};

/**
 * Reads the clinician's free-text case summaries, pulls out the key details
 * and looks for patterns linking them to the recorded EEG.
 */
export function CaseNoteInsightsPanel() {
  const run = useServerFn(mineCaseNotes);
  const [result, setResult] = useState<CaseNoteInsights | null>(null);
  const [loading, setLoading] = useState(false);

  async function analyse() {
    setLoading(true);
    try {
      setResult(await run({ data: { limit: 25 } }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not analyse your case notes.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <NotebookPen className="size-4 text-signal" /> Case-note intelligence
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The AI compares your cases and looks for patterns linking their details to the EEG you
            recorded. Details you have confirmed above are used as written.
          </p>
        </div>
        <Button onClick={analyse} disabled={loading} className="min-h-11 sm:min-h-9">
          <Sparkles className="size-4" />
          {loading ? "Reading your notes…" : "Find patterns"}
        </Button>
      </div>

      {result ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm">{result.headline}</p>
          <p className="text-xs text-muted-foreground">
            {result.notesAnalysed} written case{result.notesAnalysed === 1 ? "" : "s"} of{" "}
            {result.casesAnalysed} reviewed · {new Date(result.generatedAt).toLocaleString()}
          </p>

          {result.patterns.length ? (
            <div className="space-y-2">
              <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
                Candidate patterns
              </h3>
              {result.patterns.map((p) => (
                <article key={p.title} className="rounded-md border border-border px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Lightbulb className="size-4 text-caution" />
                    <h4 className="text-sm font-medium">{p.title}</h4>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs",
                        STRENGTH_STYLES[p.strength] ?? STRENGTH_STYLES["emerging"],
                      )}
                    >
                      {p.strength}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">{p.detail}</p>
                  {p.suggestedAction ? (
                    <p className="mt-1.5 text-sm">Next step: {p.suggestedAction}</p>
                  ) : null}
                  {p.caseCodes?.length ? (
                    <p className="metric-value mt-1.5 text-xs text-muted-foreground">
                      Seen in {p.caseCodes.join(", ")}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}

          {result.perCase.length ? (
            <div className="space-y-2">
              <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
                Key details drawn from each note
              </h3>
              {result.perCase.map((c) => (
                <article key={c.sessionId || c.caseCode} className="rounded-md bg-muted/30 px-3 py-2.5">
                  <h4 className="metric-value text-sm font-medium">{c.caseCode}</h4>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {c.keyDetails?.map((d) => (
                      <span
                        key={d}
                        className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {d}
                      </span>
                    ))}
                    {c.riskFactors?.map((d) => (
                      <span
                        key={d}
                        className="rounded-full border border-critical/40 bg-critical/10 px-2 py-0.5 text-xs text-critical"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                  {c.eegCorrelation ? (
                    <p className="mt-1.5 text-sm text-muted-foreground">{c.eegCorrelation}</p>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}

          {result.recordingGaps.length ? (
            <div>
              <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
                Worth recording next time
              </h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {result.recordingGaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.limitations.length ? (
            <p className="text-xs text-muted-foreground">
              Hypotheses only, from your own uncontrolled frontal-montage dataset —{" "}
              {result.limitations.join(" ")}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Write a case summary when you file a case; once two or more cases have notes, the AI can
          compare them.
        </p>
      )}
    </section>
  );
}
