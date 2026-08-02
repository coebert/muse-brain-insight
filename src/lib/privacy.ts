import { openTexts } from "@/lib/privacy.functions";

const PREFIX = "enc.v1.";

/**
 * Decrypt sealed free-text columns on rows fetched straight from the database.
 * Rows saved before encryption was introduced are returned unchanged.
 */
export async function unseal<T extends Record<string, unknown>>(
  rows: T[],
  fields: string[],
): Promise<T[]> {
  if (!rows.length) return rows;
  const values = rows.flatMap((r) => fields.map((f) => (r[f] as string | null) ?? null));
  if (!values.some((v) => typeof v === "string" && v.startsWith(PREFIX))) return rows;
  const { values: opened } = await openTexts({ data: { values } });
  return rows.map((r, i) => {
    const out: Record<string, unknown> = { ...r };
    fields.forEach((f, j) => {
      out[f] = opened[i * fields.length + j];
    });
    return out as T;
  });
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}