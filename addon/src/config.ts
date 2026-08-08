// Config-in-URL — CLAUDE.md §11 Tier B ("encodes them into the addon URL
// path"). Empty today (this build is single-tenant/self-hosted, Tier A);
// the shape exists so Tier B's front-door relay can add fields (target
// service hostname, debrid key) without changing every route signature.

export interface AddonConfig {
  [key: string]: unknown;
}

export function encodeConfig(config: AddonConfig): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

export function decodeConfig(raw: string): AddonConfig {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as AddonConfig) : {};
  } catch {
    return {};
  }
}
