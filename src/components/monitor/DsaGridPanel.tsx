import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { SessionDsa } from "@/components/monitor/SessionDsa";
import { formatClock } from "@/lib/eeg/format";
import type { ReplayFrame } from "@/lib/eeg/replay";

/**
 * Power, suppression and SEF95 stacked under the density spectral array on a
 * single shared time axis, so a change in the heat map can be read straight
 * down into the numbers that changed with it.
 */
export function DsaGridPanel({ frames }: { frames: ReplayFrame[] }) {
  const { spectra, times, rows } = useMemo(() => {
    const spectra = frames.map((f) => f.spectrum);
    const times = frames.map((f) => f.t);
    const rows = frames.map((f) => ({
      t: f.t,
      power: Number(f.totalPower.toFixed(2)),
      sef: Number(f.sef95.toFixed(2)),
      sr: Number(f.suppressionRatio.toFixed(1)),
    }));
    return { spectra, times, rows };
  }, [frames]);

  if (!frames.length) return null;

  const axis = {
    dataKey: "t",
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as [string, string],
    tickFormatter: (t: number) => formatClock(t),
    stroke: "hsl(var(--muted-foreground))",
    fontSize: 11,
  };

  return (
    <div className="space-y-3">
      <div className="h-56 w-full sm:h-64">
        <SessionDsa spectra={spectra} times={times} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Lane title="Total power (µV²)">
          <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis {...axis} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
            <Tooltip labelFormatter={(t: number) => formatClock(t)} />
            <Area
              type="monotone"
              dataKey="power"
              stroke="hsl(var(--signal))"
              fill="hsl(var(--signal) / 0.25)"
              isAnimationActive={false}
            />
          </AreaChart>
        </Lane>

        <Lane title="Suppression ratio (%)">
          <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis {...axis} />
            <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={11} />
            <Tooltip labelFormatter={(t: number) => formatClock(t)} />
            <Line
              type="monotone"
              dataKey="sr"
              dot={false}
              stroke="hsl(var(--destructive))"
              isAnimationActive={false}
            />
          </LineChart>
        </Lane>

        <Lane title="SEF95 (Hz)">
          <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis {...axis} />
            <YAxis domain={[0, 30]} stroke="hsl(var(--muted-foreground))" fontSize={11} />
            <Tooltip labelFormatter={(t: number) => formatClock(t)} />
            <Line
              type="monotone"
              dataKey="sef"
              dot={false}
              stroke="hsl(var(--primary))"
              isAnimationActive={false}
            />
          </LineChart>
        </Lane>
      </div>
    </div>
  );
}

function Lane({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
