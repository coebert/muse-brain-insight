import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { useCaseSession } from "@/components/monitor/CaseSessionProvider";

/** The public lab sits outside the provider that holds live and unfiled recordings. */
export const CaseResearchLink = forwardRef<HTMLAnchorElement, ComponentPropsWithoutRef<"a">>(
  function CaseResearchLink({ children, ...props }, ref) {
    const { caseRunning, hasUnfiledData } = useCaseSession();
    const keepRecordingOpen = caseRunning || hasUnfiledData;

    return (
      <Link
        {...props}
        ref={ref}
        to="/research-lab"
        target={keepRecordingOpen ? "_blank" : undefined}
        rel={keepRecordingOpen ? "noopener noreferrer" : undefined}
        title={keepRecordingOpen ? "Opens in a new tab to keep the recording open" : undefined}
      >
        {children}
        {keepRecordingOpen && (
          <>
            <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="sr-only"> (opens in a new tab)</span>
          </>
        )}
      </Link>
    );
  },
);
