import { useMemo, useRef, useState } from "react";
import { FileUp, Plug, Radio, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MUSE_SAMPLE_RATE } from "@/lib/eeg/dsp";
import { MUSE_CHANNELS, type EegSource, type MuseChannel } from "@/lib/eeg/muse";
import {
  AMPLITUDE_UNITS,
  EMPTY_CHANNEL_MAP,
  LslBridgeSource,
  ReplaySource,
  SerialIngestSource,
  WEB_SERIAL_HELP,
  checkAmplitude,
  describeChannelMap,
  inferUnit,
  isWebSerialAvailable,
  parseEegCsv,
  suggestChannelMap,
  unitScale,
  type AmplitudeUnit,
  type ChannelMap,
  type IngestConfig,
  type ParsedCsv,
} from "@/lib/eeg/ingest";

interface Props {
  /** Hands a fully configured source to the case starter. */
  onStart: (source: EegSource) => void;
  disabled?: boolean;
}

const SPEEDS = [
  { value: "1", label: "Real time (1×)" },
  { value: "2", label: "2× faster" },
  { value: "4", label: "4× faster" },
  { value: "8", label: "8× faster" },
];

/**
 * Brings EEG in from hardware other than the Muse: a CSV/TSV export, a
 * line-based serial firmware, or an LSL stream relayed over a WebSocket
 * bridge. Whatever the source, samples are converted to microvolts, resampled
 * to the analysis rate and mapped onto the four analysis electrodes, so every
 * downstream metric keeps the units and geometry it was validated on.
 */
export function IngestPanel({ onStart, disabled }: Props) {
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState("256");
  const [unit, setUnit] = useState<AmplitudeUnit>("uV");
  const [uvPerCount, setUvPerCount] = useState("0.02235");
  const [speed, setSpeed] = useState("1");
  const [map, setMap] = useState<ChannelMap>(EMPTY_CHANNEL_MAP);
  const [baud, setBaud] = useState("115200");
  const [streamColumns, setStreamColumns] = useState("TP9, AF7, AF8, TP10");
  const [bridgeUrl, setBridgeUrl] = useState("ws://localhost:8765");
  const fileInput = useRef<HTMLInputElement>(null);

  const dataColumns = useMemo(
    () =>
      parsed
        ? parsed.columns.filter((_, i) => i !== parsed.timeColumn)
        : streamColumns
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
    [parsed, streamColumns],
  );

  const scale = unitScale(unit, Number(uvPerCount));
  const described = describeChannelMap(map);

  /** Amplitude sanity per mapped electrode, using the file's own samples. */
  const amplitude = useMemo(() => {
    if (!parsed) return [];
    return MUSE_CHANNELS.filter((c) => map[c]).map((electrode) => {
      const column = map[electrode]!;
      const index = parsed.columns.indexOf(column);
      const samples = (parsed.data[index] ?? []).slice(0, 20_000);
      return { electrode, column, check: checkAmplitude(samples, scale) };
    });
  }, [parsed, map, scale]);

  async function handleFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const result = parseEegCsv(text);
      setParsed(result);
      setFileName(file.name);
      if (result.inferredRate) setRate(String(result.inferredRate));
      const skip = result.timeColumn === null ? [] : [result.timeColumn];
      const suggestion = suggestChannelMap(result.columns, skip);
      setMap(suggestion);
      // Guess the unit from the first mapped column's own amplitude.
      const firstColumn = MUSE_CHANNELS.map((c) => suggestion[c]).find(Boolean);
      if (firstColumn) {
        const index = result.columns.indexOf(firstColumn);
        setUnit(inferUnit((result.data[index] ?? []).slice(0, 20_000)).unit);
      }
    } catch (e) {
      setParsed(null);
      setFileName(null);
      setError(e instanceof Error ? e.message : "That file could not be read.");
    }
  }

  function baseConfig(label: string): IngestConfig {
    return {
      sampleRate: Number(rate) || MUSE_SAMPLE_RATE,
      unit,
      ...(unit === "counts" ? { uvPerCount: Number(uvPerCount) } : {}),
      channelMap: map,
      speed: Number(speed) || 1,
      label,
    };
  }

  function startReplay() {
    if (!parsed) return;
    const columns: Record<string, number[]> = {};
    for (const electrode of MUSE_CHANNELS) {
      const column = map[electrode];
      if (!column || columns[column]) continue;
      const index = parsed.columns.indexOf(column);
      columns[column] = parsed.data[index] ?? [];
    }
    try {
      onStart(new ReplaySource(columns, baseConfig(`Replay · ${fileName ?? "file"}`)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The replay could not be started.");
    }
  }

  function startSerial() {
    onStart(
      new SerialIngestSource({
        baudRate: Number(baud) || 115200,
        columns: dataColumns,
        config: baseConfig(`Serial · ${baud} baud`),
      }),
    );
  }

  function startBridge() {
    onStart(
      new LslBridgeSource({
        url: bridgeUrl.trim(),
        columns: dataColumns,
        config: baseConfig(`LSL bridge · ${bridgeUrl.trim()}`),
      }),
    );
  }

  const rateNumber = Number(rate);
  const rateValid = Number.isFinite(rateNumber) && rateNumber >= 20 && rateNumber <= 20_000;
  const mappedAny = described.mapped.length > 0;

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Upload className="size-4 text-primary" />
        <h3 className="text-sm font-medium">Other hardware</h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Bring raw EEG in from any amplifier: replay a CSV export, read a serial firmware, or
        consume an LSL stream through a local WebSocket bridge. Samples are converted to
        microvolts and resampled to {MUSE_SAMPLE_RATE} Hz before analysis.
      </p>

      <Tabs defaultValue="file">
        <TabsList className="w-full">
          <TabsTrigger value="file" className="flex-1 min-h-11 text-xs">
            <FileUp className="size-3.5" /> File replay
          </TabsTrigger>
          <TabsTrigger value="serial" className="flex-1 min-h-11 text-xs">
            <Plug className="size-3.5" /> Serial
          </TabsTrigger>
          <TabsTrigger value="lsl" className="flex-1 min-h-11 text-xs">
            <Radio className="size-3.5" /> LSL bridge
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="mt-3 space-y-3">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <Button
            variant="secondary"
            className="min-h-11 w-full"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp className="size-4" /> {fileName ? `Change file (${fileName})` : "Choose a recording"}
          </Button>
          {parsed ? (
            <p className="metric-value text-xs text-muted-foreground">
              {parsed.rowCount} rows · {parsed.columns.length} columns ·{" "}
              {parsed.hasHeader ? "header row" : "no header"}
              {parsed.inferredRate ? ` · ${parsed.inferredRate} Hz detected` : " · rate unknown"}
              {parsed.warnings.length ? ` · ${parsed.warnings.join(" ")}` : ""}
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label htmlFor="ingest-speed" className="text-xs">
                Replay speed
              </Label>
              <Select value={speed} onValueChange={setSpeed}>
                <SelectTrigger id="ingest-speed" className="min-h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPEEDS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button className="min-h-11 w-full" disabled={disabled || !parsed || !rateValid || !mappedAny} onClick={startReplay}>
            Start replay
          </Button>
        </TabsContent>

        <TabsContent value="serial" className="mt-3 space-y-3">
          {isWebSerialAvailable() ? null : (
            <p className="rounded-md border border-caution/40 bg-caution/10 p-2 text-xs text-muted-foreground">
              {WEB_SERIAL_HELP}
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label htmlFor="ingest-baud" className="text-xs">
                Baud rate
              </Label>
              <Input
                id="ingest-baud"
                className="min-h-11"
                inputMode="numeric"
                value={baud}
                onChange={(e) => setBaud(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="ingest-columns" className="text-xs">
                Channel order per line
              </Label>
              <Input
                id="ingest-columns"
                className="min-h-11"
                value={streamColumns}
                onChange={(e) => {
                  setStreamColumns(e.target.value);
                  setParsed(null);
                  setMap(
                    suggestChannelMap(
                      e.target.value
                        .split(",")
                        .map((c) => c.trim())
                        .filter(Boolean),
                    ),
                  );
                }}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Each line may be delimited numbers, a JSON array, or a JSON object of named channels.
          </p>
          <Button
            className="min-h-11 w-full"
            disabled={disabled || !isWebSerialAvailable() || !rateValid || !mappedAny}
            onClick={startSerial}
          >
            Open serial port
          </Button>
        </TabsContent>

        <TabsContent value="lsl" className="mt-3 space-y-3">
          <div>
            <Label htmlFor="ingest-bridge" className="text-xs">
              Bridge WebSocket URL
            </Label>
            <Input
              id="ingest-bridge"
              className="min-h-11"
              value={bridgeUrl}
              onChange={(e) => setBridgeUrl(e.target.value)}
              placeholder="ws://localhost:8765"
            />
          </div>
          <div>
            <Label htmlFor="ingest-lsl-columns" className="text-xs">
              Channel order in the stream
            </Label>
            <Input
              id="ingest-lsl-columns"
              className="min-h-11"
              value={streamColumns}
              onChange={(e) => {
                setStreamColumns(e.target.value);
                setParsed(null);
                setMap(
                  suggestChannelMap(
                    e.target.value
                      .split(",")
                      .map((c) => c.trim())
                      .filter(Boolean),
                  ),
                );
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Browsers cannot speak LSL directly. Run a relay on the recording machine that forwards
            the stream as JSON chunks over WebSocket, then point this at it.
          </p>
          <Button
            className="min-h-11 w-full"
            disabled={disabled || !bridgeUrl.trim() || !rateValid || !mappedAny}
            onClick={startBridge}
          >
            Connect to bridge
          </Button>
        </TabsContent>
      </Tabs>

      {/* Shared signal definition — the part that decides whether the numbers mean anything. */}
      <div className="mt-4 space-y-3 border-t border-border/60 pt-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Label htmlFor="ingest-rate" className="text-xs">
              Device sample rate (Hz)
            </Label>
            <Input
              id="ingest-rate"
              className="min-h-11"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {rateValid
                ? `Resampled to ${MUSE_SAMPLE_RATE} Hz for analysis.`
                : "Enter a rate between 20 and 20000 Hz."}
            </p>
          </div>
          <div>
            <Label htmlFor="ingest-unit" className="text-xs">
              Amplitude unit
            </Label>
            <Select value={unit} onValueChange={(v) => setUnit(v as AmplitudeUnit)}>
              <SelectTrigger id="ingest-unit" className="min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AMPLITUDE_UNITS.map((u) => (
                  <SelectItem key={u.value} value={u.value}>
                    {u.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {AMPLITUDE_UNITS.find((u) => u.value === unit)?.detail}
            </p>
          </div>
        </div>

        {unit === "counts" ? (
          <div>
            <Label htmlFor="ingest-scale" className="text-xs">
              µV per count
            </Label>
            <Input
              id="ingest-scale"
              className="min-h-11"
              inputMode="decimal"
              value={uvPerCount}
              onChange={(e) => setUvPerCount(e.target.value)}
            />
          </div>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          {MUSE_CHANNELS.map((electrode: MuseChannel) => (
            <div key={electrode}>
              <Label htmlFor={`ingest-map-${electrode}`} className="text-xs">
                {electrode}
              </Label>
              <Select
                value={map[electrode] ?? "__none__"}
                onValueChange={(v) =>
                  setMap((prev) => ({ ...prev, [electrode]: v === "__none__" ? null : v }))
                }
              >
                <SelectTrigger id={`ingest-map-${electrode}`} className="min-h-11">
                  <SelectValue placeholder="Not mapped" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Not mapped</SelectItem>
                  {dataColumns.map((column) => (
                    <SelectItem key={column} value={column}>
                      {column}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        <p
          className={`text-xs ${described.mapped.length === 4 ? "text-muted-foreground" : "text-caution"}`}
        >
          {described.note}
        </p>

        {amplitude.length > 0 ? (
          <ul className="space-y-1">
            {amplitude.map(({ electrode, column, check }) => (
              <li
                key={electrode}
                className={`metric-value text-[11px] ${check.ok ? "text-muted-foreground" : "text-caution"}`}
              >
                {electrode} ← {column}: {check.p95uV.toFixed(1)} µV p95 — {check.note}
              </li>
            ))}
          </ul>
        ) : null}

        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  );
}
