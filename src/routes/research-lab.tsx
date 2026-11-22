import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Activity, ArrowRight, Brain, ChevronDown, RotateCcw, ScanLine, Waves } from "lucide-react";
import { LAB_SAMPLES } from "@/lib/eeg/sample-lab";
import { RESEARCH_EXAMPLES } from "@/lib/eeg/sample-research";
import { LocalSeizureTrial } from "@/components/research-lab/LocalSeizureTrial";
import { LocalStrokeTrial } from "@/components/research-lab/LocalStrokeTrial";
import type { Analysis, Result } from "@/components/research-lab/sample-presentation";
import "@/components/research-lab/research-lab.css";

export const Route = createFileRoute("/research-lab")({
  head: () => ({ meta: [{ title: "EEG research lab — CortexTrace" }] }),
  validateSearch: validateSelection,
  component: ResearchLab,
});

const tools = [
  { id: "depth", title: "Depth of anaesthesia", icon: Waves, sample: "anaesthesia" },
  { id: "seizure", title: "Seizure detection", icon: Activity, sample: "rhythmic" },
  { id: "age", title: "Brain age", icon: Brain, sample: "rest-alpha" },
  { id: "stroke", title: "Stroke research", icon: ScanLine, sample: "left-change" },
] as const;

function sampleChoices(
  analysis: Analysis,
): readonly { id: string; label: string; description?: string }[] {
  return analysis === "age" || analysis === "stroke" ? RESEARCH_EXAMPLES[analysis] : LAB_SAMPLES;
}

function validateSelection(search: Record<string, unknown>): {
  analysis?: Analysis;
  sample?: string;
} {
  const tool = tools.find((item) => item.id === search["analysis"]) ?? tools[0];
  const sample = sampleChoices(tool.id).find((item) => item.id === search["sample"]);
  return { analysis: tool.id, sample: sample?.id ?? tool.sample };
}

function makePath(values: number[], extent: number, width: number, middle: number, height: number) {
  const parts: string[] = [];
  const lastIndex = Math.max(1, values.length - 1);
  let draw = false;
  values.forEach((voltage, index) => {
    if (!Number.isFinite(voltage)) {
      draw = false;
      return;
    }
    const x = (index * width) / lastIndex;
    const y = middle - (voltage * height) / extent;
    parts.push((draw ? "L" : "M") + x.toFixed(2) + "," + y.toFixed(2));
    draw = true;
  });
  return parts.join(" ");
}

function Waveform({ result }: { result: Result }) {
  const [lead, setLead] = useState("pair");
  const [zoom, setZoom] = useState(false);
  const [initial, setInitial] = useState(false);
  const plotId = useId().replace(/:/g, "");
  const current = initial && result.initialTraces ? result.initialTraces : result.traces;
  const traces = lead === "pair" ? current.slice(0, 2) : current.filter((t) => t.label === lead);
  const duration = zoom ? Math.min(2, result.seconds) : result.seconds;
  const start = (initial ? 0 : result.start) + result.seconds - duration;
  const display = traces.map((t) => ({
    label: t.label,
    values: t.values.slice(
      Math.max(0, Math.round(t.values.length * (1 - duration / (result.seconds || 1)))),
    ),
  }));
  let peak = 0;
  for (const t of [...result.traces, ...(result.initialTraces ?? [])])
    for (const v of t.values) if (Number.isFinite(v)) peak = Math.max(peak, Math.abs(v));
  const extent = Math.max(5, Math.ceil(peak / 5) * 5);
  const width = 900,
    lane = 80,
    height = Math.max(1, display.length) * lane;
  return (
    <div className="rl-wave">
      <div className="rl-wave-head">
        <div>
          <strong>EEG waveform</strong>
          <span>{result.rate} Hz · Synthetic signal</span>
        </div>
        <div className="rl-wave-controls">
          {result.initialTraces && (
            <label>
              Window
              <select
                value={initial ? "initial" : "final"}
                onChange={(e) => setInitial(e.target.value === "initial")}
              >
                <option value="initial">First {result.seconds} s</option>
                <option value="final">Last {result.seconds} s</option>
              </select>
            </label>
          )}
          {result.traces.length > 1 && (
            <label>
              Leads
              <select value={lead} onChange={(e) => setLead(e.target.value)}>
                <option value="pair">First two leads</option>
                {result.traces.map((t) => (
                  <option key={t.label} value={t.label}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {result.seconds > 2 && (
            <button type="button" aria-pressed={zoom} onClick={() => setZoom(!zoom)}>
              {zoom ? "Show full trace" : "Zoom to 2 s"}
            </button>
          )}
        </div>
      </div>
      {initial && (
        <p className="rl-trace-note">
          Showing the opening waveform. Final readouts use the end of the recording.
        </p>
      )}
      {display.length > 0 && duration > 0 ? (
        <>
          <div className="rl-plot">
            <div className="rl-plot-labels">
              {display.map((t) => (
                <span key={t.label}>{t.label}</span>
              ))}
            </div>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              role="img"
              aria-labelledby={plotId}
              style={{ height }}
            >
              <title id={plotId}>
                {display.map((t) => t.label).join(" and ")} synthetic EEG from {start.toFixed(1)} to{" "}
                {(start + duration).toFixed(1)} seconds, scale ±{extent} microvolts per lead
              </title>
              {Array.from({ length: 9 }, (_, i) => (
                <line
                  key={i}
                  x1={(i * width) / 8}
                  x2={(i * width) / 8}
                  y1="0"
                  y2={height}
                  stroke="#28434b"
                  strokeDasharray="2 4"
                />
              ))}
              {display.map((trace, i) => (
                <g key={trace.label}>
                  <line
                    x1="0"
                    x2={width}
                    y1={lane * (i + 0.5)}
                    y2={lane * (i + 0.5)}
                    stroke="#34515a"
                  />
                  <path
                    d={makePath(trace.values, extent, width, lane * (i + 0.5), lane * 0.44)}
                    fill="none"
                    stroke={i === 0 ? "#74e6d6" : "#a8c7ff"}
                    strokeWidth="1.3"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ))}
            </svg>
          </div>
          <div className="rl-wave-axis">
            <span>{start.toFixed(1)} s</span>
            <span>
              ±{extent} µV · {result.relativeTime ? "Excerpt time" : "Recording time"}
            </span>
            <span>{(start + duration).toFixed(1)} s</span>
          </div>
        </>
      ) : (
        <p>Waveform unavailable for this example.</p>
      )}
    </div>
  );
}

function ExposureComparison({ exposure }: { exposure: NonNullable<Result["exposure"]> }) {
  const [context, setContext] = useState<"unrecorded" | "declared">("unrecorded");
  const reading = exposure[context];
  const bands = [
    { label: "Slow · 0.5–4 Hz", fraction: exposure.bands.slow },
    { label: "Alpha · 8–12 Hz", fraction: exposure.bands.alpha },
    { label: "Beta · 13–30 Hz", fraction: exposure.bands.beta },
    { label: "Gamma · 30–47 Hz", fraction: exposure.bands.gamma },
  ];
  return (
    <div className="rl-exposure">
      <h3>Ketamine exposure and spectral power</h3>
      <p>
        Change the exposure recorded for the same EEG to compare the original COEBIS model's
        response. Drug exposure is supplied by the example.
      </p>
      <fieldset>
        <legend>Recorded ketamine exposure</legend>
        {(["unrecorded", "declared"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="rl-ketamine-context"
              value={value}
              checked={context === value}
              onChange={() => setContext(value)}
            />
            {value === "unrecorded" ? "Unrecorded" : "Documented exposure"}
          </label>
        ))}
      </fieldset>
      <dl className="rl-context-metrics" aria-live="polite" aria-atomic="true">
        <div>
          <dt>Original COEBIS</dt>
          <dd>{reading.coebis == null ? "Withheld" : reading.coebis.toFixed(1) + " / 100"}</dd>
        </div>
        <div>
          <dt>Ketamine adjustment</dt>
          <dd>{reading.delta == null ? "Withheld" : reading.delta.toFixed(1) + " points"}</dd>
        </div>
        <div>
          <dt>Adjustment status</dt>
          <dd>
            {reading.coebis == null
              ? "Unavailable"
              : reading.corrected
                ? "Applied"
                : reading.advisory
                  ? "Advisory only"
                  : "Inactive"}
          </dd>
        </div>
      </dl>
      <h4>Frontal spectral power</h4>
      <p>Share of 0.5–47 Hz power in the final AF7 window.</p>
      <dl className="rl-bands">
        {bands.map((band) => (
          <div key={band.label}>
            <dt>{band.label}</dt>
            <dd>{band.fraction == null ? "Unavailable" : band.fraction.toFixed(1) + "%"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ResearchLab() {
  const search = Route.useSearch();
  const changeSelection = Route.useNavigate();
  const active = tools.find((tool) => tool.id === search.analysis) ?? tools[0];
  const analysis = active.id;
  const sample = search.sample ?? active.sample;
  const key = analysis + "/" + sample;
  const [outcome, setOutcome] = useState<{ key: string; data: Result | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<string, Result>());
  const result = outcome?.key === key ? outcome.data : null;
  const error = outcome?.key === key && outcome.data === null;
  const choices = sampleChoices(analysis);
  const example = choices.find((s) => s.id === sample);
  useEffect(() => {
    const cached = cache.current.get(key);
    if (cached) {
      setOutcome({ key, data: cached });
      return;
    }

    let worker: Worker | undefined;
    let cancelled = false;
    const fail = () => {
      if (!cancelled) setOutcome({ key, data: null });
      worker?.terminate();
    };
    try {
      worker = new Worker(new URL("../components/research-lab/sample.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<Result>) => {
        if (cancelled) return;
        cache.current.set(key, event.data);
        setOutcome({ key, data: event.data });
        worker?.terminate();
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.postMessage({ analysis, sample });
    } catch {
      fail();
    }
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [analysis, sample, key, attempt]);
  function select(nextAnalysis: Analysis, nextSample: string) {
    if (nextAnalysis === analysis && nextSample === sample) {
      setOutcome(null);
      setAttempt((value) => value + 1);
      return;
    }
    void changeSelection({
      search: { analysis: nextAnalysis, sample: nextSample },
      resetScroll: false,
    });
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tools.length
        : event.key === "ArrowLeft"
          ? (index + tools.length - 1) % tools.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tools.length - 1
              : null;
    if (next == null) return;
    event.preventDefault();
    const tool = tools[next]!;
    select(tool.id, tool.sample);
    document.getElementById("rl-tab-" + tool.id)?.focus();
  }
  return (
    <div className="research-lab">
      <a className="rl-skip" href="#rl-workspace">
        Skip to analysis
      </a>
      <header className="rl-header">
        <div className="rl-header-inner">
          <Link to="/" preload={false} className="rl-brand">
            <Activity aria-hidden="true" size={23} />
            CortexTrace
          </Link>
          <Link to="/" preload={false} className="rl-clinician">
            Open monitor <ArrowRight aria-hidden="true" size={15} />
          </Link>
        </div>
      </header>
      <main id="rl-workspace" className="rl-main">
        <div className="rl-intro">
          <h1>EEG research lab</h1>
          <p>
            Try the developing analyses on synthetic EEG. Each example runs in your browser without
            a headset or patient record.
          </p>
        </div>
        <div role="tablist" aria-label="EEG analyses" className="rl-tabs">
          {tools.map((tool, i) => (
            <button
              key={tool.id}
              id={"rl-tab-" + tool.id}
              type="button"
              role="tab"
              aria-controls="rl-panel"
              aria-selected={analysis === tool.id}
              tabIndex={analysis === tool.id ? 0 : -1}
              onKeyDown={(e) => navigate(e, i)}
              onClick={() => {
                if (analysis !== tool.id) select(tool.id, tool.sample);
              }}
            >
              <tool.icon aria-hidden="true" size={19} />
              {tool.title}
            </button>
          ))}
        </div>
        <section
          role="tabpanel"
          id="rl-panel"
          aria-labelledby={"rl-tab-" + analysis}
          tabIndex={0}
          className="rl-panel"
        >
          <div className="rl-panel-title">
            <h2>{active.title}</h2>
            <button
              className="rl-reset"
              type="button"
              onClick={() => select(analysis, active.sample)}
            >
              <RotateCcw aria-hidden="true" size={14} />
              Reset example
            </button>
          </div>
          <div className="rl-grid">
            <div className="rl-recording">
              <label className="rl-example" htmlFor="rl-example">
                <span>Sample recording</span>
                <span className="rl-select-wrap">
                  <select
                    id="rl-example"
                    value={sample}
                    onChange={(e) => select(analysis, e.target.value)}
                  >
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} aria-hidden="true" />
                </span>
              </label>
              {example?.description && <p className="rl-description">{example.description}</p>}
              {analysis === "depth" && (
                <div className="rl-related">
                  <span>Compare</span>
                  <button
                    type="button"
                    aria-pressed={sample === "suppression"}
                    onClick={() => select(analysis, "suppression")}
                  >
                    Burst suppression
                  </button>
                  <button
                    type="button"
                    aria-pressed={sample === "emg"}
                    onClick={() => select(analysis, "emg")}
                  >
                    Muscle artefact
                  </button>
                  <button
                    type="button"
                    aria-pressed={sample === "activated"}
                    onClick={() => select(analysis, "activated")}
                  >
                    Drug context
                  </button>
                </div>
              )}
              {result && <Waveform key={key + "/" + attempt} result={result} />}
            </div>
            <div
              className="rl-output"
              data-withheld={result?.withheld}
              aria-busy={!result && !error}
              aria-live="polite"
              aria-atomic="true"
            >
              {result ? (
                <>
                  <h3>{result.label}</h3>
                  <p className="rl-number">
                    {result.value} {result.unit && <span>{result.unit}</span>}
                  </p>
                  <p className="rl-interpretation">{result.explanation}</p>
                  {result.metrics.length > 0 && (
                    <dl className="rl-metrics">
                      {result.metrics.map((m) => (
                        <div key={m.label}>
                          <dt>{m.label}</dt>
                          <dd>{m.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </>
              ) : error ? (
                <>
                  <h3>Analysis unavailable</h3>
                  <p>The example could not be processed.</p>
                  <button
                    type="button"
                    className="rl-reset"
                    onClick={() => select(analysis, sample)}
                  >
                    Try again
                  </button>
                </>
              ) : (
                <p>Calculating sample results…</p>
              )}
            </div>
          </div>
          {result?.exposure && <ExposureComparison exposure={result.exposure} />}
          {result && (
            <div className="rl-method">
              <div>
                <h3>How to read this result</h3>
                <p>{result.evidence}</p>
              </div>
              <dl>
                <div>
                  <dt>Method</dt>
                  <dd>{result.model}</dd>
                </div>
                <div>
                  <dt>Montage</dt>
                  <dd>{result.montage}</dd>
                </div>
              </dl>
            </div>
          )}
          {analysis === "stroke" && <LocalStrokeTrial />}
          {analysis === "seizure" && <LocalSeizureTrial />}
        </section>
      </main>
    </div>
  );
}
