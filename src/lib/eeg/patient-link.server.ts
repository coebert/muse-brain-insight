import { createHash, createHmac } from "node:crypto";

/**
 * Keyed one-way fingerprint of a patient identifier. Stored instead of the
 * identifier itself so a repeat patient is recognised without anything being
 * decrypted, and so the stored value cannot be brute-forced without the key.
 */
export function fingerprintIdentifier(normalised: string): string {
  const raw = process.env["PHI_ENCRYPTION_KEY"];
  if (!raw) throw new Error("PHI_ENCRYPTION_KEY is not configured.");
  const key = createHash("sha256").update(raw).digest();
  return createHmac("sha256", key).update(`patient-link:${normalised}`).digest("hex");
}
