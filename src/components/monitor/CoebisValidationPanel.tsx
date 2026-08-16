import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";

import { getCoebisValidation } from "@/lib/eeg/coebis-validation.functions";
import { describeTerm } from "@/lib/eeg/covariates";

const FAMILY_LABEL: Record<string, string> = {
  raw: "Published open index",
  affine: "COEBIS (pooled)",
  covariate: "COEBIS (patient-adjusted)",
  mixed: "COEBIS (patient-adjusted + case intercepts)",
};

function num(v: number | null | undefined, digits = 1): string {
  return v == null ? "—" : v.toFixed(digits);
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

/**
 * Honest validation: every figure comes from readings in cases the model was
 * not fitted on, so it reflects what the app would show on the next patient
 * rather than how well it can memorise the ones already logged.
 */
export function CoebisValidationPanel() {
  const fetchReport = useServerFn(getCoebisValidation);
  const { data, isLoading, error } = useQuery({
    queryKey: ["coebis-validation"],
    queryFn: () => fetchReport(),
  });

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Cross-validating against your paired readings…
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" className="text-sm text-critical">
        {error instanceof Error ? error.message : "Could not run the validation."}
      </p>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-4">
      <p className="panel p-3 text-sm">{data.summary}</p>

      <section className="panel overflow-x-auto p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4 text-signal" /> Held-out agreement by model
        </h3>
        <table className="w-full min-w-[42rem] text-sm">
          <thead className="text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="py-1 text-left">Model</th>
              <th className="py-1 text-right">MAE</th>
              <th className="py-1 text-right">Bias</th>
              <th className="py-1 text-right">RMSE</th>
              <th className="py-1 text-right">Within 5</th>
              <th className="py-1 text-right">Within 10</th>
              <th className="py-1 text-right">CCC</th>
            </tr>
          </thead>
          <tbody className="metric-value">
            {data.families.map((f) => (
              <tr
                key={f.family}
                className={
                  f.family === data.best ? "border-t border-border bg-signal/10" : "border-t border-border"
                }
              >
                <td className="py-1.5 text-left font-medium">
                  {FAMILY_LABEL[f.family] ?? f.family}
                  {f.family === data.best ? (
                    <span className="ml-2 rounded-full bg-signal/20 px-2 py-0.5 text-[10px] text-signal">
                      best
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 text-right">{num(f.outOfSample.mae)}</td>
                <td className="py-1.5 text-right">{num(f.outOfSample.bias)}</td>
                <td className="py-1.5 text-right">{num(f.outOfSample.rmse)}</td>
                <td className="py-1.5 text-right">{pct(f.outOfSample.within5)}</td>
                <td className="py-1.5 text-right">{pct(f.outOfSample.within10)}</td>
                <td className="py-1.5 text-right">{num(f.outOfSample.ccc, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          Each row is scored leave-one-case-out across {data.cases} case{data.cases === 1 ? "" : "s"}{" "}
          and {data.n} paired reading{data.n === 1 ? "" : "s"}.
        </p>
      </section>

      {data.terms.length ? (
        <section className="panel p-3">
          <h3 className="mb-2 text-sm font-semibold">Patient-specific corrections currently learned</h3>
          <ul className="space-y-1 text-sm">
            {data.terms.map((t) => (
              <li key={`${t.group}:${t.level}`} className="flex items-baseline justify-between gap-3">
                <span>{describeTerm(t)}</span>
                <span className="metric-value text-xs text-muted-foreground">
                  {t.n} reading{t.n === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel overflow-x-auto p-3">
        <h3 className="mb-2 text-sm font-semibold">Held-out error by subgroup</h3>
        <table className="w-full min-w-[38rem] text-sm">
          <thead className="text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="py-1 text-left">Group</th>
              <th className="py-1 text-left">Level</th>
              <th className="py-1 text-right">Readings</th>
              <th className="py-1 text-right">Cases</th>
              <th className="py-1 text-right">MAE before</th>
              <th className="py-1 text-right">MAE after</th>
              <th className="py-1 text-right">Within 10</th>
            </tr>
          </thead>
          <tbody className="metric-value">
            {data.strata.map((s) => (
              <tr key={`${s.group}:${s.level}`} className="border-t border-border">
                <td className="py-1.5 text-left capitalize">{s.group}</td>
                <td className="py-1.5 text-left">{s.level}</td>
                <td className="py-1.5 text-right">{s.n}</td>
                <td className="py-1.5 text-right">{s.cases}</td>
                <td className="py-1.5 text-right">{num(s.before.mae)}</td>
                <td
                  className={
                    s.after.mae != null && s.before.mae != null && s.after.mae > s.before.mae
                      ? "py-1.5 text-right text-warning"
                      : "py-1.5 text-right"
                  }
                >
                  {num(s.after.mae)}
                </td>
                <td className="py-1.5 text-right">{pct(s.after.within10)}</td>
              </tr>
            ))}
            {data.strata.length ? null : (
              <tr>
                <td colSpan={7} className="py-3 text-center text-muted-foreground">
                  No subgroup breakdown yet — log paired readings with age, sex and regimen recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <TriangleAlert className="size-4 text-warning" /> Where more data would help most
        </h3>
        {data.gaps.length ? (
          <ul className="space-y-1 text-sm">
            {data.gaps.map((g) => (
              <li key={`${g.group}:${g.level}`} className="flex items-baseline justify-between gap-3">
                <span className="capitalize">
                  {g.group}: <span className="normal-case">{g.level}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {g.have} reading{g.have === 1 ? "" : "s"} from {g.cases} case{g.cases === 1 ? "" : "s"} — need about{" "}
                  {Math.max(0, g.need - g.have)} more
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Every tracked subgroup has enough paired readings to earn its own correction.
          </p>
        )}
        {data.missingAge || data.missingRegimen || data.unfiled ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {data.missingAge} reading{data.missingAge === 1 ? "" : "s"} without an age band,{" "}
            {data.missingRegimen} without a regimen, {data.unfiled} not yet linked to a filed case.
          </p>
        ) : null}
      </section>
    </div>
  );
}
