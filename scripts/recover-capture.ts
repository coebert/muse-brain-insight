/**
 * One-off: file an unfiled continuous capture as a case.
 * Usage: bun scripts/recover-capture.ts <capture_key>
 */
import { createClient } from "@supabase/supabase-js";

import { harvestOneCapture } from "../src/lib/eeg/capture-harvest.server";

const captureKey = process.argv[2];
if (!captureKey) throw new Error("capture key required");

const admin = createClient(
  process.env["SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { persistSession: false } },
) as never;

const { data, error } = await (admin as any)
  .from("capture_sessions")
  .select("id, user_id, capture_key, started_at, device_name, filed_session_id, harvested_session_id")
  .eq("capture_key", captureKey)
  .maybeSingle();
if (error) throw new Error(error.message);
if (!data) throw new Error("capture not found");
if (data.filed_session_id || data.harvested_session_id) throw new Error("already on the timeline");

const done = await harvestOneCapture(admin, data, 7200);
console.log(JSON.stringify(done, null, 2));
