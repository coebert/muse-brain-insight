import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Target } from "lucide-react";

import { getCoebisValidation } from "@/lib/eeg/coebis-validation.functions";

/**
 * Where the next paired readings would do the most good. COEBIS learns a
 * separate correction per patient subgroup, so a case in an under-represented
 * age band or regimen is worth far more than another in a well-covered one —
 * this puts that list next to the place readings are actually entered.
 */
export function CoebisGapHint({ className }: { className?: string }) {
  const fetchReport = useServerFn(getCoebisValidation);
  const { data } = useQuery({
    queryKey: ["coebis-validation"],
    queryFn: () => fetchReport(),
    staleTime: 5 * 60_000,
  });

  const gaps = data?.gaps?.slice(0, 3) ?? [];
  if (!gaps.length) return null;

  return (
    <div className={className}>
      <p className="flex items-center gap-1.5 text-[11px] tracking-wide text-muted-foreground uppercase">
        <Target className="size-3.5" /> Readings needed most
      </p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {gaps.map((g) => (
          <li
            key={`${g.group}:${g.level}`}
            className="rounded-full bg-muted/60 px-2 py-1 text-[11px]"
          >
            <span className="capitalize">{g.group}</span>: {g.level}
            <span className="ml-1 text-muted-foreground">
              {Math.max(0, g.need - g.have)} more
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
