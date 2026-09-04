import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadPathologyLabelEvaluation } from "@/lib/eeg/pathology-labels.server";
const session = JSON.parse(readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`,"utf8")) as any;
const url = process.env["VITE_SUPABASE_URL"]!;
const key = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_ANON_KEY"]!;
const sb = createClient(url, key, { auth:{persistSession:false,autoRefreshToken:false}, global:{headers:{Authorization:`Bearer ${session.access_token}`}}});
const r = await loadPathologyLabelEvaluation(sb as never);
console.log(JSON.stringify({ inventory: (r as any).inventory ?? null, axes: (r as any).axes?.map((a:any)=>({axis:a.axis,label:a.label,n:a.n,cases:a.cases,positives:a.positives,auc:a.auc,ci:a.ci ?? a.aucCi,reliable:a.reliable,note:a.note,threshold:a.threshold,sensitivity:a.sensitivity,specificity:a.specificity})) }, null, 2));
