import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadPathologyLabelEvaluation } from "@/lib/eeg/pathology-labels.server";
const s = JSON.parse(readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`,"utf8"));
const sb = createClient(process.env["VITE_SUPABASE_URL"]!, process.env["VITE_SUPABASE_PUBLISHABLE_KEY"]!, {
  auth:{persistSession:false,autoRefreshToken:false},
  global:{headers:{Authorization:`Bearer ${s.access_token}`}}});
const r = await loadPathologyLabelEvaluation(sb as never);
console.log(JSON.stringify(r,null,1).slice(0,6000));
