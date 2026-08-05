import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc.v1.";

function key(): Buffer {
  const raw = process.env["PHI_ENCRYPTION_KEY"];
  if (!raw) throw new Error("PHI_ENCRYPTION_KEY is not configured.");
  // Derive a fixed 32-byte AES key from the stored secret, whatever its format.
  return createHash("sha256").update(raw).digest();
}

/** Encrypt a free-text field with AES-256-GCM. Returns null for empty input. */
export function seal(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Decrypt a sealed field. Values written before encryption was added pass through. */
export function open(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!value.startsWith(PREFIX)) return value;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return "[unreadable]";
  }
}
