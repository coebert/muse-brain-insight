import { useState } from "react";
import { AlertTriangle, Copy, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { PasskeyFailure } from "@/lib/webauthn-support";

interface Props {
  failure: PasskeyFailure;
  /** Standalone URL offered when opening in a new tab is likely to help. */
  standaloneUrl?: string | undefined;
  onDismiss?: (() => void) | undefined;
}

/** Inline, persistent diagnostic for a failed passkey attempt. */
export function PasskeyErrorNotice({ failure, standaloneUrl, onDismiss }: Props) {
  const [showDetail, setShowDetail] = useState(false);

  async function copyReason() {
    try {
      await navigator.clipboard.writeText(
        `${failure.title}\n[${failure.code}] ${failure.reason}\nURL: ${
          typeof window !== "undefined" ? window.location.href : ""
        }\nUser agent: ${typeof navigator !== "undefined" ? navigator.userAgent : ""}`,
      );
      toast.success("Failure details copied.");
    } catch {
      toast.error("Could not copy — select the reason text manually.");
    }
  }

  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-xs"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{failure.title}</p>
          <p className="mt-1 text-muted-foreground">{failure.explanation}</p>

          <p className="mt-2 font-medium">Try this:</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-muted-foreground">
            {failure.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            {failure.suggestNewTab && standaloneUrl && (
              <a
                className="inline-flex items-center gap-1 font-medium underline"
                href={standaloneUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open in a new tab <ExternalLink className="size-3" />
              </a>
            )}
            <button
              type="button"
              className="font-medium underline"
              onClick={() => setShowDetail((v) => !v)}
            >
              {showDetail ? "Hide exact reason" : "Show exact reason"}
            </button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => void copyReason()}
            >
              <Copy className="size-3" /> Copy details
            </Button>
          </div>

          {showDetail && (
            <pre className="mt-2 overflow-x-auto rounded border border-border bg-background/60 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
              [{failure.code}] {failure.reason}
            </pre>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss passkey error"
            className="text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
