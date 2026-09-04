import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadSuppressionReport } from "@/lib/eeg/suppression-model.server";
const session = JSON.parse(readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`,"utf8")) as any;
const url = process.env["VITE_SUPABASE_URL"]!;
const admin = createClient(url, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, { auth:{persistSession:false,autoRefreshToken:false}});
const userId = session.user_id as string;
const report = await loadSuppressionReport(admin as never, userId, 120000);
console.log(JSON.stringify({ fit: { ...report.fit, model: report.fit.model, folds: undefined }, pairing: report.pairing }, null, 2).slice(0, 6000));
