import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Settings2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIsAdmin } from "@/hooks/useRole";
import { supabase } from "@/integrations/supabase/client";
import { ADMIN_SECTIONS } from "@/components/admin/AdminShell";

/** Every address that lives behind the admin gate. */
const ADMIN_PATHS = new Set<string>(
  ADMIN_SECTIONS.flatMap((section) => section.items.map((item) => item.to as string)),
);

/** The five bedside destinations. Everything else lives in the admin area. */
const BEDSIDE: {
  to: "/" | "/bedside" | "/cases" | "/patients" | "/notes";
  label: string;
  exact: boolean;
}[] = [
  { to: "/", label: "Monitor", exact: true },
  { to: "/bedside", label: "Bedside", exact: false },
  { to: "/cases", label: "Cases", exact: false },
  { to: "/patients", label: "Patients", exact: false },
  { to: "/notes", label: "Notes", exact: false },
];

/**
 * Shared header navigation. On bedside pages it shows the five clinician
 * destinations; inside the admin area the sidebar takes over and this shrinks
 * to a way back out.
 */
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

  if (inAdmin) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/admin">Admin home</Link>
        </Button>
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/">Back to monitor</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showBrand ? (
        <Link to="/" className="mr-2 flex min-w-0 items-center gap-2">
          <Activity className="size-5 shrink-0 text-signal" />
          <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
            CortexTrace
          </span>
        </Link>
      ) : null}

      {BEDSIDE.filter((item) => !(compact && item.exact)).map((item) => (
        <Button
          asChild
          key={item.to}
          variant="ghost"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-testid={`nav-${item.label.toLowerCase()}`}
        >
          <Link
            to={item.to}
            activeProps={{ className: "bg-accent" }}
            activeOptions={{ exact: item.exact }}
          >
            {item.label}
          </Link>
        </Button>
      ))}

      <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
        <Link to="/settings" activeProps={{ className: "bg-accent" }}>
          <Settings2 className="size-4" /> Settings
        </Link>
      </Button>

      {isAdmin ? (
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/admin" activeProps={{ className: "bg-accent" }}>
            <ShieldCheck className="size-4" /> Admin
          </Link>
        </Button>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-9"
        onClick={() => void supabase.auth.signOut()}
      >
        Sign out
      </Button>
    </div>
  );
}
