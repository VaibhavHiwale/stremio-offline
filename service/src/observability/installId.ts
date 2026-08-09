import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadOrCreateSecret } from "../transport/secretStore.js";

/**
 * A random per-install identifier, generated once and persisted (reuses the
 * same generate-on-first-boot/persist pattern as the file-token secret) —
 * lets error records from the same deployment be correlated over time
 * without storing anything that identifies a person. Only the hash is ever
 * written to a log; the raw id never leaves this file.
 */
export function getInstallIdHash(storageRoot: string): string {
  const installId = loadOrCreateSecret(join(storageRoot, ".offline", "install-id"));
  return createHash("sha256").update(installId).digest("hex");
}
