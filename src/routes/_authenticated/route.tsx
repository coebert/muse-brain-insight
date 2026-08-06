import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { ActiveCaseBar } from "@/components/monitor/ActiveCaseBar";
import { CaseSessionProvider } from "@/components/monitor/CaseSessionProvider";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  // The case session lives here, above the outlet, so a running case keeps
  // streaming and holds everything it has gathered while the clinician moves
  // between pages.
  component: () => (
    <CaseSessionProvider>
      <ActiveCaseBar />
      <Outlet />
    </CaseSessionProvider>
  ),
});
