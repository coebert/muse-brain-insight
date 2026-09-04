import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env["VITE_SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {auth:{persistSession:false}});
const { data } = await admin.from("bis_paired_points").select("source_lineage").range(0, 99999);
const c: Record<string, number> = {};
for (const r of data as any[]) c[r.source_lineage ?? "null"] = (c[r.source_lineage ?? "null"] ?? 0) + 1;
console.log(c, "total", (data as any[]).length);
