import { useCallback, useRef, useState } from "react";
import { Laptop, Loader2, Play, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_BRIDGE_URL,
  MacBridgeSource,
  type BridgeHello,
  type BridgeLogLine,
} from "@/lib/eeg/mac-bridge";
import type { EegSource } from "@/lib/eeg/muse";

const RUN_COMMAND = "swift bridge/macos/MindGuardBridge.swift";

interface Props {
  onStart: (source: EegSource, onConnectionError: (error: unknown) => void) => unknown;
}

/**
 * Connects to the macOS CoreBluetooth bridge. The bridge, not the browser, owns
 * the headband's BLE link, which is what makes the bonded/encrypted connection
 * the FC-11 firmware insists on possible at all.
 */
export function MacBridgePanel({ onStart }: Props) {
  const [url, setUrl] = useState(DEFAULT_BRIDGE_URL);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hello, setHello] = useState<BridgeHello | null>(null);
  const [logs, setLogs] = useState<BridgeLogLine[]>([]);
  const sourceRef = useRef<MacBridgeSource | null>(null);

  const appendLog = useCallback((line: BridgeLogLine) => {
    setLogs((previous) => [...previous.slice(-60), line]);
  }, []);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    setLogs([]);
    setHello(null);
    const source = new MacBridgeSource({
      url: url.trim() || DEFAULT_BRIDGE_URL,
      onHello: setHello,
      onLog: appendLog,
    });
    sourceRef.current = source;
    try {
      await onStart(source, (cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the bridge.");
      await source.stop();
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <Laptop className="size-4 text-signal" aria-hidden />
        <h3 className="text-sm font-medium">macOS headband bridge</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Browsers cannot make the encrypted Bluetooth link the Regul8 / FocusCalm firmware requires.
        Run the bridge on this Mac and it will hand the decoded EEG to the app over a local
        connection.
      </p>

      <div className="rounded-md border border-border/60 bg-muted/40 p-2">
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Terminal className="size-3.5" aria-hidden /> Run this in Terminal first
        </div>
        <code className="block break-all text-xs">{RUN_COMMAND}</code>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bridge-url" className="text-xs">
          Bridge address
        </Label>
        <Input
          id="bridge-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={DEFAULT_BRIDGE_URL}
          spellCheck={false}
          className="h-11"
        />
      </div>

      <Button onClick={connect} disabled={connecting} className="min-h-11 w-full sm:w-auto">
        {connecting ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Play className="size-4" aria-hidden />
        )}
        {connecting ? "Connecting to the bridge…" : "Connect via bridge"}
      </Button>

      {error ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {hello ? (
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Fact label="Headband" value={hello.device} />
          <Fact label="Firmware" value={hello.firmware} />
          <Fact label="Channels" value={hello.channels.join(", ")} />
          <Fact label="Sample rate" value={`${hello.sampleRate} Hz`} />
        </dl>
      ) : null}

      {logs.length ? (
        <Collapsible>
          <CollapsibleTrigger className="text-xs text-muted-foreground underline underline-offset-4">
            Bridge log ({logs.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2 text-xs">
              {logs.map((line, index) => (
                <li
                  key={`${line.at}-${index}`}
                  className={
                    line.level === "error"
                      ? "text-destructive"
                      : line.level === "warn"
                        ? "text-caution"
                        : "text-muted-foreground"
                  }
                >
                  {line.message}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="metric-value truncate">{value}</dd>
    </div>
  );
}
