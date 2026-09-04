import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AppRole = "admin" | "clinician";

export interface Person {
  id: string;
  email: string;
  role: AppRole;
  createdAt: string;
  lastSignInAt: string | null;
  invitedPending: boolean;
}

async function callerIsAdmin(context: {
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown }> };
  userId: string;
}): Promise<boolean> {
  const { data } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  return data === true;
}

/** Role of the signed-in clinician. Everyone who is not an admin is a clinician. */
export const getMyRole = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const isAdmin = await callerIsAdmin(context as never);
    return { role: (isAdmin ? "admin" : "clinician") as AppRole };
  });

/** Throws when the caller is not an admin. Used by the admin route gate. */
export const assertAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    if (!(await callerIsAdmin(context as never))) throw new Error("Forbidden");
    return { ok: true as const };
  });

export const listPeople = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Person[]> => {
    if (!(await callerIsAdmin(context as never))) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: users, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw new Error(error.message);

    const { data: roles } = await supabaseAdmin.from("user_roles").select("user_id, role");
    const admins = new Set((roles ?? []).filter((r) => r.role === "admin").map((r) => r.user_id));

    return users.users.map((u) => ({
      id: u.id,
      email: u.email ?? "(no email)",
      role: admins.has(u.id) ? ("admin" as const) : ("clinician" as const),
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at ?? null,
      invitedPending: !u.last_sign_in_at,
    }));
  });

export const inviteClinician = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { email: string; redirectTo: string; asAdmin?: boolean }) => data)
  .handler(async ({ data, context }) => {
    if (!(await callerIsAdmin(context as never))) throw new Error("Forbidden");
    const email = data.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: invited, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: data.redirectTo,
    });
    if (error) throw new Error(error.message);

    if (data.asAdmin && invited.user) {
      await supabaseAdmin
        .from("user_roles")
        .upsert({ user_id: invited.user.id, role: "admin" }, { onConflict: "user_id,role" });
    }
    return { ok: true as const, email };
  });

export const setPersonRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { userId: string; role: AppRole }) => data)
  .handler(async ({ data, context }) => {
    if (!(await callerIsAdmin(context as never))) throw new Error("Forbidden");
    if (data.userId === context.userId && data.role !== "admin") {
      throw new Error("You cannot remove your own admin access.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.role === "admin") {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .upsert({ user_id: data.userId, role: "admin" }, { onConflict: "user_id,role" });
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .delete()
        .eq("user_id", data.userId)
        .eq("role", "admin");
      if (error) throw new Error(error.message);
    }
    return { ok: true as const };
  });

export const revokePerson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data, context }) => {
    if (!(await callerIsAdmin(context as never))) throw new Error("Forbidden");
    if (data.userId === context.userId) throw new Error("You cannot revoke your own account.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
