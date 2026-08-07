import { Info } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { PARAMETER_INFO, type ParameterInfoKey } from "@/lib/eeg/parameter-info";

interface ParameterInfoProps {
  parameter: ParameterInfoKey;
  className?: string;
  /** Slightly larger hit area for bedside/touch use. */
  size?: "sm" | "md";
}

/**
 * Small "i" marker that opens a clinician-facing explanation of the parameter:
 * what it means, the physiology behind it, and how far it can be trusted.
 */
export function ParameterInfo({ parameter, className, size = "sm" }: ParameterInfoProps) {
  const info = PARAMETER_INFO[parameter];
  if (!info) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`About ${info.title}`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            // The visible dot stays small, but a transparent pseudo-element widens the
            // tap target to ~44px so it is reachable with a thumb at the bedside.
            "relative inline-flex shrink-0 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors before:absolute before:-inset-3 before:content-[''] hover:border-signal hover:text-signal focus-visible:ring-1 focus-visible:ring-signal focus-visible:outline-none",
            size === "sm" ? "h-4 w-4" : "h-5 w-5",
            className,
          )}
        >
          <Info className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        collisionPadding={12}
        className="z-50 w-[min(22rem,calc(100vw-2rem))] p-0"
      >
        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-3 p-4 text-xs leading-relaxed">
            <div>
              <p className="metric-value text-sm text-foreground">{info.title}</p>
              <p className="mt-1 text-muted-foreground">{info.summary}</p>
            </div>
            <Section title="Clinical significance" body={info.significance} />
            <Section title="Underlying physiology" body={info.physiology} />
            <Section title="Reliability & pitfalls" body={info.reliability} />
            {info.range ? <Section title="Typical range" body={info.range} /> : null}
            <p className="border-t border-border pt-2 text-[11px] text-muted-foreground/80">
              Decision support only — from a 4-electrode frontal montage. Not a certified medical
              device; correlate with the raw EEG and the clinical picture.
            </p>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
        {title}
      </p>
      <p className="mt-0.5 text-foreground/90">{body}</p>
    </div>
  );
}
