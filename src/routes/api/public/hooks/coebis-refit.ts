/**
 * Scheduled trigger for the COEBIS refit pipeline.
 *
 * Called by pg_cron over HTTP. The caller is verified against
 * COEBIS_REFIT_SECRET inside the handler, because /api/public/* bypasses site
 * auth. Work per run is bounded (owners per run, lineages per owner) and a
 * database lease keeps concurrent runs from overlapping.
 */
import { createFileRoute } from "@tanstack/react-router";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/hooks/coebis-refit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["COEBIS_REFIT_SECRET"];
        if (!secret) return json({ error: "Refit secret not configured" }, 500);
        const provided =
          request.headers.get("x-refit-secret") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "";
        if (!timingSafeEqual(provided, secret)) {
          return json({ error: "Unauthorized" }, 401);
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { runScheduledRefit } = await import("@/lib/eeg/coebis-refit.server");
          const result = await runScheduledRefit(supabaseAdmin as never);
          return json({
            ok: true,
            ran: result.ran,
            skipped: result.skipped ?? null,
            users: result.users,
            runs: result.reports.map((r) => ({
              userId: r.userId,
              status: r.status,
              lineagesRefitted: r.lineagesRefitted,
              modelsPromoted: r.modelsPromoted,
              summary: r.summary,
              remainingLineages: r.remainingLineages,
              done: r.done,
            })),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return json({ ok: false, error: message }, 500);
        }
      },
    },
  },
});
