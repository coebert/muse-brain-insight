import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getExternalValidation } from "@/lib/eeg/external-validation.functions";
import type { ExternalValidationReport } from "@/lib/eeg/external-validation";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);

export function ExternalValidationPanel() {
  const run = useServerFn(getExternalValidation);
  const [report, setReport] = useState<ExternalValidationReport | null>(null);
  const [busy, setBusy] = useState(false);

  const onRun = async () => {
    setBusy(true);
    try {
      setReport(await run({}));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not run external validation");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">External validation</CardTitle>
        <CardDescription>
          Fits COEBIS on your own paired readings only, then scores it separately against each
          imported external collection. External data is never mixed into training, and results are
          never pooled across collections — a weak montage stays visible.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={onRun} disabled={busy} className="min-h-11">
          {busy ? "Scoring…" : "Run external validation"}
        </Button>

        {report && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{report.summary}</p>
            {report.lineages.map((l) => (
              <div key={l.lineage} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{l.lineage}</span>
                  <Badge variant="secondary">{l.kind}</Badge>
                  <Badge variant="outline">
                    {l.n} rows · {l.cases} case(s)
                  </Badge>
                  {l.harmonization && (
                    <Badge variant="outline">harmonised {l.harmonization.version}</Badge>
                  )}
                </div>

                {l.agreement && (
                  <p className="text-sm">
                    MAE {l.agreement.mae ?? "—"} · bias {l.agreement.bias ?? "—"} · CCC{" "}
                    {l.agreement.ccc ?? "—"} · within 5: {l.agreement.within5 ?? "—"}%
                    {l.baseline?.mae != null && (
                      <span className="text-muted-foreground">
                        {" "}
                        (unadjusted baseline MAE {l.baseline.mae})
                      </span>
                    )}
                  </p>
                )}

                {(l.suppressionSensitivity != null || l.suppressionRoc) && (
                  <p className="text-sm">
                    Burst suppression — sensitivity {pct(l.suppressionSensitivity)}, specificity{" "}
                    {pct(l.suppressionSpecificity)}
                    {l.suppressionRoc?.auc != null && <> , AUC {l.suppressionRoc.auc}</>}
                  </p>
                )}

                {l.pk?.pk != null && (
                  <p className="text-sm">
                    State ordering Pk {l.pk.pk} (n = {l.pk.n})
                  </p>
                )}

                {l.notes.map((n) => (
                  <p key={n} className="text-xs text-muted-foreground">
                    {n}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
