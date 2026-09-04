import { Link } from "@tanstack/react-router";
import { Activity, ChevronDown, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";

const TOOLS = [
  { to: "/brainwaves", label: "Live brainwaves" },
  { to: "/trends", label: "Session trends" },

  { to: "/compare", label: "Compare metrics" },
  { to: "/calibrate", label: "Depth calibration" },
  { to: "/validate", label: "Agreement report" },
  { to: "/replay", label: "COEBIS replay" },
  { to: "/feedback", label: "Alert feedback" },
  { to: "/performance", label: "Alert tuning" },
  { to: "/coebis", label: "COEBIS training data" },
  { to: "/models", label: "Model versions" },
  { to: "/pathology", label: "Pathology validation" },
  { to: "/patients", label: "Patient scoreboard" },
  { to: "/outcomes", label: "Case outcomes" },

] as const;

/** Shared header navigation: Monitor, Cases, a Tools menu and Settings. */
export function AppNav({
  showBrand = true,
  compact = false,
}: {
  showBrand?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {showBrand ? (
        <Link to="/" className="mr-2 flex min-w-0 items-center gap-2">
          <Activity className="size-5 shrink-0 text-signal" />
          <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
            CortexTrace
          </span>
        </Link>
      ) : null}

      {!compact ? (
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/" activeProps={{ className: "bg-accent" }} activeOptions={{ exact: true }}>
            Monitor
          </Link>
        </Button>
      ) : null}

      <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
        <Link to="/cases" activeProps={{ className: "bg-accent" }}>
          Cases
        </Link>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
            Tools <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {TOOLS.map((t) => (
            <DropdownMenuItem key={t.to} asChild>
              <Link to={t.to}>{t.label}</Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
        <Link to="/settings" activeProps={{ className: "bg-accent" }}>
          <Settings2 className="size-4" /> Settings
        </Link>
      </Button>

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
