import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env["VITE_SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {auth:{persistSession:false}});
const all: any[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await admin.from("bis_paired_points").select("source_lineage, recorded_at, features").range(from, from + 999);
  if (error) throw error;
  all.push(...(data as any[]));
  if ((data as any[]).length < 1000) break;
}
const c: Record<string, {n:number; cases:Set<string>; first:string}> = {};
for (const r of all) {
  const k = r.source_lineage ?? "null";
  c[k] ??= {n:0, cases:new Set(), first:r.recorded_at};
  c[k].n++; c[k].cases.add(String(r.features?.caseRef ?? "?"));
  if (r.recorded_at < c[k].first) c[k].first = r.recorded_at;
}
for (const [k,v] of Object.entries(c)) console.log(k, v.n, "cases", v.cases.size, "from", v.first);
console.log("total", all.length);
