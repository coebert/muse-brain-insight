import { Check, X } from "lucide-react";

import {
  STREAM_TEST_MAX_HZ,
  STREAM_TEST_MIN_HZ,
  streamTestCellColor,
  type StreamTestResult,
} from "@/lib/eeg/stream-test";

/**
 * Shows what the stream test actually produced: the pass/fail checks and the
 * spectral array those seconds generated, so the clinician sees the same
 * picture the case will draw before committing to a recording.
 */
export function StreamTestReport({ result }: { result: StreamTestResult }) {
  const rows = result.freqs.length;
  return (
    <div
      className={`mt-3 rounded-md border p-3 text-xs ${
        result.passed ? "border-signal/40 bg-signal/5" : "border-critical/40 bg-critical/10"
      }`}
    >
      <p className={`font-medium ${result.passed ? "text-signal" : "text-critical"}`}>
        {result.summary}
      </p>

      <ul className="metric-value mt-2 grid gap-1.5">
        {result.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2">
            {check.ok ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-signal" aria-hidden />
            ) : (
              <X className="mt-0.5 size-3.5 shrink-0 text-critical" aria-hidden />
            )}
            <span className="flex-1">
              <span className="font-medium text-foreground">{check.label}</span>
              <span className="block text-muted-foreground">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {result.columns.length ? (
        <figure className="mt-3">
          <figcaption className="text-[11px] text-muted-foreground">
            Live spectral array from the test capture — {result.columns.length} s,{" "}
            {STREAM_TEST_MIN_HZ}–{STREAM_TEST_MAX_HZ} Hz, low frequencies at the bottom.
          </figcaption>
          <div
            className="mt-1 flex h-24 gap-px overflow-hidden rounded-sm border border-border"
            role="img"
            aria-label={`Spectral array of the test capture, spectral edge ${result.sef95.toFixed(1)} hertz`}
          >
            {result.columns.map((column, i) => (
              <div key={i} className="flex flex-1 flex-col-reverse">
                {column.map((db, k) => (
                  <div
                    key={k}
                    style={{
                      height: `${100 / rows}%`,
                      backgroundColor: streamTestCellColor(db, result.dbFloor, result.dbCeiling),
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-4">
            {[
              ["Spectral edge", `${result.sef95.toFixed(1)} Hz`],
              ["Amplitude", `${result.amplitudeUv.toFixed(0)} µV`],
              ["Delivered", `${Math.round(result.deliveredRate)} Hz`],
              [
                "Bands δ/θ/α/β",
                [result.bands.delta, result.bands.theta, result.bands.alpha, result.bands.beta]
                  .map((v) => `${Math.round(v * 100)}`)
                  .join("/") + "%",
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="metric-value text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </figure>
      ) : null}
    </div>
  );
}
