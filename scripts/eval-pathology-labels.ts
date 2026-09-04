import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadPathologyLabelEvaluation } from "@/lib/eeg/pathology-labels.server";
const s = JSON.parse(readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`,"utf8"));
const sb = createClient(process.env["VITE_SUPABASE_URL"]!, process.env["VITE_SUPABASE_PUBLISHABLE_KEY"]!, {
  auth:{persistSession:false,autoRefreshToken:false},
  global:{headers:{Authorization:`Bearer ${s.access_token}`}}});
const r = await loadPathologyLabelEvaluation(sb as never);
console.log(JSON.stringify({inventory:r.inventory, axes:r.axes.map(a=>({key:a.key,label:a.label,n:a.epochs,cases:a.cases,positives:a.positives,auc:a.auc,ci:a.aucCi,reliable:a.reliable,note:a.note}))},null,1));
