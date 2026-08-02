import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const startPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { buildRegistrationOptions } = await import("./webauthn.server");
    const email = String(context.claims['email'] ?? "");
    if (!email) throw new Error("Account has no email address.");
    return buildRegistrationOptions(context.userId, email);
  });

export const finishPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { response: Record<string, unknown>; label: string }) => data)
  .handler(async ({ data, context }) => {
    const { saveRegistration } = await import("./webauthn.server");
    const email = String(context.claims['email'] ?? "");
    return saveRegistration(context.userId, email, data.response, data.label || "This device");
  });

export const startPasskeyLogin = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string }) => data)
  .handler(async ({ data }) => {
    const { buildAuthenticationOptions } = await import("./webauthn.server");
    return buildAuthenticationOptions(data.email);
  });

export const finishPasskeyLogin = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string; response: Record<string, unknown> }) => data)
  .handler(async ({ data }) => {
    const { verifyAuthenticationAndMint } = await import("./webauthn.server");
    return verifyAuthenticationAndMint(data.email, data.response);
  });