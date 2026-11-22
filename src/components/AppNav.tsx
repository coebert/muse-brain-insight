import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, ChevronDown, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CaseResearchLink } from "@/components/monitor/CaseResearchLink";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsAdmin } from "@/hooks/useRole";
import { supabase } from "@/integrations/supabase/client";
import { ADMIN_SECTIONS } from "@/components/admin/AdminShell";

const ADMIN_PATHS = new Set<string>(
  ADMIN_SECTIONS.flatMap((section) => section.items.map((item) => item.to as string)),
);

const RECORDS = [
  { to: "/cases", label: "Cases" },
  { to: "/patients", label: "Patients" },
  { to: "/notes", label: "Notes" },
] as const;

export function AppNav({
  showBrand = true,
  compact = false,
}: {
  showBrand?: boolean;
  compact?: boolean;
}) {
  const { isAdmin } = useIsAdmin();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inAdmin = ADMIN_PATHS.has(pathname) || pathname.startsWith("/admin");
  const currentRecord = RECORDS.find(({ to }) => pathname === to || pathname.startsWith(to + "/"));

  if (inAdmin) {
    return (
      <nav aria-label="Workspace" className="flex flex-wrap items-center gap-1.5">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/admin">Admin home</Link>
        </Button>
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <CaseResearchLink>Research lab</CaseResearchLink>
        </Button>
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/">Back to monitor</Link>
        </Button>
      </nav>
    );
  }

  return (
    <nav aria-label="Workspace" className="flex min-w-0 flex-wrap items-center gap-1">
      {showBrand ? (
        <Link to="/" className="mr-2 flex min-h-11 min-w-0 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring">
          <Activity aria-hidden="true" className="size-5 shrink-0 text-signal" />
          <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
            CortexTrace
          </span>
        </Link>
      ) : null}

      {!compact && (
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9" data-testid="nav-monitor">
          <Link to="/" activeProps={{ className: "bg-accent" }} activeOptions={{ exact: true }}>Monitor</Link>
        </Button>
      )}
      <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9" data-testid="nav-bedside">
        <Link to="/bedside" activeProps={{ className: "bg-accent" }}>Bedside</Link>
      </Button>
      <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9" data-testid="nav-research-lab">
        <CaseResearchLink>Research lab</CaseResearchLink>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={currentRecord ? "secondary" : "ghost"} size="sm" className="min-h-11 sm:min-h-9" aria-label={currentRecord ? `Records, current page: ${currentRecord.label}` : "Records"}>
            {currentRecord?.label ?? "Records"} <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {RECORDS.map(({ to, label }) => (
            <DropdownMenuItem key={to} asChild>
              <Link to={to} className="min-h-11 sm:min-h-9" data-testid={`nav-${label.toLowerCase()}`} activeProps={{ className: "bg-accent font-medium" }}>
                {label}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={pathname === "/settings" ? "secondary" : "ghost"} size="sm" className="min-h-11 sm:min-h-9">
            <SlidersHorizontal aria-hidden="true" className="size-4" />
            Account <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link to="/settings" className="min-h-11 sm:min-h-9" activeProps={{ className: "bg-accent font-medium" }}>Settings</Link>
          </DropdownMenuItem>
          {isAdmin && (
            <DropdownMenuItem asChild>
              <Link to="/admin" className="min-h-11 sm:min-h-9">Admin</Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="min-h-11 sm:min-h-9" onSelect={() => void supabase.auth.signOut()}>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
