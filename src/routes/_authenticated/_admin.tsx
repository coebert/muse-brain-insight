import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AdminShell } from "@/components/admin/AdminShell";
import { assertAdmin } from "@/lib/roles.functions";

export const Route = createFileRoute("/_authenticated/_admin")({
  ssr: false,
  // Server-checked: the role is verified in a server function, and every
  // admin action re-checks it, so this gate is convenience, not the security.
  beforeLoad: async () => {
    try {
      await assertAdmin();
    } catch {
      throw redirect({ to: "/" });
    }
  },
  component: () => (
    <AdminShell>
      <Outlet />
    </AdminShell>
  ),
});
