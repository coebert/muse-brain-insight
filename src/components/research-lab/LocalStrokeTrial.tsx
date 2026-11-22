import { useRef, useState, type ChangeEvent } from "react";
import {
  parseStrokeCheckpoint,
  runStrokeTrial,
  STROKE_FIXTURES,
  type FrontalCheckpoint,
  type StrokeFixture,
} from "@/lib/eeg/local-stroke-trial";

/** Optional replay with the user's own model. Files and results stay in transient page memory. */
export function LocalStrokeTrial() {
  const [model, setModel] = useState<FrontalCheckpoint | null>(null);
  const [fixture, setFixture] = useState<StrokeFixture>("symmetric");
  const [result, setResult] = useState<ReturnType<typeof runStrokeTrial> | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  function clear() {
    sequence.current++;
    setModel(null);
    setResult(null);
    setError("");
    if (fileInput.current) fileInput.current.value = "";
  }

  async function chooseFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    const revision = ++sequence.current;
    setModel(null);
    setResult(null);
    setError("");
    if (!file) return;
    try {
      if (file.size > 16_384)
        throw new Error("Choose an extracted frontal model JSON file under 16 KB.");
      const checkpoint = parseStrokeCheckpoint(await file.text());
      if (revision === sequence.current) setModel(checkpoint);
    } catch (reason) {
      if (revision === sequence.current)
        setError(reason instanceof Error ? reason.message : "Could not load this model.");
    }
  }

  function replay() {
    if (!model) return;
    try {
      setError("");
      setResult(runStrokeTrial(model, fixture));
    } catch (reason) {
      setResult(null);
      setError(reason instanceof Error ? reason.message : "Could not score this sample.");
    }
  }

  return (
    <details className="rounded-xl border border-slate-300 bg-white text-slate-900">
      <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-teal-700">
        Try your prior-stroke model file
      </summary>
      <div className="space-y-4 border-t border-slate-200 p-4 text-sm">
        <h3 className="font-semibold text-slate-900">Local model replay</h3>
        <p>
          Unzip the MindGuard stroke research package and select{" "}
          <code>model/china-frontal.json</code> or <code>model/pooled-frontal.json</code>. The file
          stays in this browser tab.
        </p>
        <label className="block space-y-1">
          <span className="block font-medium">Frontal model file</span>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            onChange={chooseFile}
            className="block w-full max-w-full text-xs file:mr-2 file:rounded file:border file:border-slate-300 file:bg-slate-50 file:px-2 file:py-1.5"
          />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block space-y-1">
            <span className="block font-medium">Two-minute synthetic EEG</span>
            <select
              value={fixture}
              onChange={(e) => {
                setFixture(e.target.value as StrokeFixture);
                setResult(null);
              }}
              className="min-h-10 max-w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900"
            >
              {STROKE_FIXTURES.map((sample) => (
                <option key={sample.id} value={sample.id}>
                  {sample.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!model}
            onClick={replay}
            className="min-h-10 rounded-md bg-teal-800 px-3 font-medium text-white hover:bg-teal-900 disabled:opacity-45"
          >
            Run local model
          </button>
          {model && (
            <button type="button" onClick={clear} className="min-h-10 rounded-md px-2 underline">
              Clear model
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-red-800">
            {error}
          </p>
        )}
        <div aria-live="polite" aria-atomic="true">
          {model && !result && <p>Model loaded · {model.development}</p>}
          {result && (
            <div className="space-y-1 rounded-md bg-slate-100 p-3">
              <p className="font-semibold">
                {result.score === null
                  ? "Score withheld for insufficient signal"
                  : `Research score ${result.score.toFixed(3)}`}
              </p>
              <p>{result.good} of 15 eight-second windows usable · Fp1–F7 and Fp2–F8 · 500 Hz</p>
              {result.score !== null && (
                <p>
                  A higher score means greater resemblance to the prior-stroke training group. This
                  synthetic replay cannot determine whether a patient has an acute stroke.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
