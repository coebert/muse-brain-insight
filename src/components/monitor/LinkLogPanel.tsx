import { useEffect, useState } from "react";
import { Download, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatLinkLog,
  linkUptimes,
  museLinkLog,
  type LinkEvent,
} from "@/lib/eeg/muse-link-log";

const TONE: Partial<Record<LinkEvent["kind"], string>> = {
  dropped: "text-critical",
  "reconnect-failed": "text-critical",
  "keepalive-failed": "text-critical",
  silent: "text-caution",
  nudge: "text-caution",
  "reconnect-attempt": "text-caution",
  attached: "text-signal",
  "reconnect-ok": "text-signal",
};

/**
 * What the headband link actually did: every attach, silence, drop and
 * reconnect, kept on this computer so a case that ended in a dropout can be
 * explained afterwards. Connection events only — no EEG, no patient details.
 */
export function LinkLogPanel() {
  const [events, setEvents] = useState<LinkEvent[]>([]);
  useEffect(() => museLinkLog.subscribe(setEvents), []);

  const spans = linkUptimes(events);
  const recent = [...events].reverse().slice(0, 60);

  const download = () => {
    const blob = new Blob([formatLinkLog(events)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `headband-link-log-${new Date().toISOString().slice(0, 19)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Headband link history</CardTitle>
        <CardDescription>
          Every time the headband connected, went quiet, dropped or came back — kept on this
          computer so a dropout can be explained afterwards. No EEG or patient information is
          stored here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {spans.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Last connected stretches:{" "}
            {spans
              .slice(-5)
              .map((s) => `${Math.floor(s.seconds / 60)}m ${s.seconds % 60}s`)
              .join(" · ")}
          </p>
        )}

        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing recorded yet. Connect a headband and the link history builds itself.
          </p>
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto text-sm">
            {recent.map((event, i) => (
              <li key={`${event.at}-${i}`} className="flex flex-wrap gap-x-2">
                <span className="metric-value text-xs text-muted-foreground">
                  {new Date(event.at).toLocaleTimeString()}
                </span>
                <span className={TONE[event.kind] ?? ""}>{event.message}</span>
                {event.uptimeSeconds !== undefined && (
                  <span className="text-xs text-muted-foreground">
                    after {Math.floor(event.uptimeSeconds / 60)}m {event.uptimeSeconds % 60}s
                    connected
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={download} disabled={events.length === 0}>
            <Download className="mr-1.5 size-3.5" /> Download log
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => museLinkLog.clear()}
            disabled={events.length === 0}
          >
            <Trash2 className="mr-1.5 size-3.5" /> Clear
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
