import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Generates a signing secret on first boot and persists it, so signed file
 * tokens (CLAUDE.md §3 Rule 4) survive restarts instead of invalidating every
 * outstanding link each time the process starts.
 */
export function loadOrCreateSecret(secretPath: string): string {
  try {
    return readFileSync(secretPath, "utf8").trim();
  } catch {
    const secret = randomBytes(32).toString("hex");
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
  }
}
