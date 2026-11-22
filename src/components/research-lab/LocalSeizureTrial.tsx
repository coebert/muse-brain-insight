import { useRef, useState, type ChangeEvent } from "react";
import fixture from "@/lib/eeg/synthetic-seizure-features.json";
import {
  decodeSeizureTrialFixture,
  parseSeizureCheckpoint,
  runSeizureTrial,
  type AlarmMode,
  type SeizureCheckpoint,
} from "@/lib/eeg/local-seizure-trial";

export function LocalSeizureTrial() {
  const [model, setModel] = useState<SeizureCheckpoint | null>(null);
  const [mode, setMode] = useState<AlarmMode>("lower_alarm");
  const [result, setResult] = useState<ReturnType<typeof runSeizureTrial> | null>(null);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  function reset() {
    revision.current++;
    setModel(null);
    setError("");
    setResult(null);
  }
  async function choose(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    reset();
    const version = revision.current;
    if (!file) return;
    try {
      if (file.size > 1_000_000)
        throw new Error("Choose an extracted frontal model JSON file under 1 MB.");
      const next = parseSeizureCheckpoint(await file.text());
      if (version === revision.current) setModel(next);
    } catch (err) {
      if (version === revision.current)
        setError(err instanceof Error ? err.message : "Could not load this model.");
    }
  }
  function replay() {
    if (!model) return;
    try {
      setError("");
      setResult(runSeizureTrial(model, decodeSeizureTrialFixture(fixture), mode));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Could not score this sample.");
    }
  }
  const valid = result?.scores.filter((n): n is number => n !== null) ?? [];
  return (
    <details className="rounded-xl border border-slate-300 bg-white text-slate-900">
      <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-teal-700">
        Try your seizure model file
      </summary>
      <div className="space-y-4 border-t border-slate-200 p-4 text-sm">
        <h3 className="font-semibold text-slate-900">Local seizure model replay</h3>
        <p>
          Unzip the MindGuard seizure research package and select{" "}
          <code>boston-frontal-expanded.json</code> or <code>boston-frontal.json</code> from its
          model folder. The selected file stays in this tab.
        </p>
        <p>
          The model reads stored features from a synthetic 192-second frontal recording. An evolving
          rhythm runs from 64 to 128 seconds. One electrode goes flat from 144 to 160 seconds.
        </p>
        <label className="block space-y-1">
          <span className="block font-medium">Frontal seizure model file</span>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            onChange={choose}
            className="block w-full max-w-full text-xs file:mr-2 file:rounded file:border file:border-slate-300 file:bg-slate-50 file:px-2 file:py-1.5"
          />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block space-y-1">
            <span className="block font-medium">Alert policy</span>
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as AlarmMode);
                setResult(null);
              }}
              className="min-h-10 max-w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900"
            >
              <option value="lower_alarm">Fewer alerts</option>
              <option value="sensitivity_priority">Prioritise sensitivity</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!model}
            onClick={replay}
            className="min-h-10 rounded-md bg-teal-800 px-3 font-medium text-white hover:bg-teal-900 disabled:opacity-45"
          >
            Run local seizure model
          </button>
          {model && (
            <button
              type="button"
              onClick={() => {
                reset();
                if (fileInput.current) fileInput.current.value = "";
              }}
              className="min-h-10 rounded-md px-2 underline"
            >
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
          {model && !result && <p>Model loaded · ready to replay</p>}
          {result && (
            <div className="space-y-1 rounded-md bg-slate-100 p-3">
              <p className="font-semibold">
                {result.alarms.length
                  ? "Alert onset at " + result.alarms.map((t) => t + " s").join(", ")
                  : "No alerts under this policy"}
              </p>
              <p>
                {valid.length} of {result.scores.length} eight-second windows scored · peak research
                score {valid.length ? Math.max(...valid).toFixed(3) : "unavailable"}
              </p>
              <p>
                Scores are withheld during electrode loss. Alerts on an artificial rhythm do not
                establish clinical seizure-detection performance.
              </p>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
