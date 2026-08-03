import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Shown in the fallback so the clinician knows which panel failed. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a rendering fault in one monitor panel from blanking the whole bedside
 * screen. The failing panel is replaced by a visible, recoverable notice —
 * silent failure is unacceptable during a case.
 */
export class MonitorErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[monitor] ${this.props.label ?? "panel"} failed`, error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="panel flex h-full min-h-[140px] flex-col items-start justify-center gap-2 p-4"
      >
        <p className="flex items-center gap-2 text-sm text-critical">
          <AlertTriangle className="size-4" aria-hidden />
          {this.props.label ?? "Monitor panel"} stopped updating
        </p>
        <p className="text-xs text-muted-foreground">
          Streaming and recording continue. {error.message}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          onClick={() => this.setState({ error: null })}
        >
          <RotateCcw className="size-4" aria-hidden /> Retry panel
        </Button>
      </div>
    );
  }
}
