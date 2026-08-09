import type { DebridService } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";
import { getDebridAccount } from "../db/debridAccounts.js";
import { allDebridResolver } from "./alldebrid.js";
import { debridLinkResolver } from "./debridlink.js";
import { premiumizeResolver } from "./premiumize.js";
import { realDebridResolver } from "./realdebrid.js";
import { torBoxResolver } from "./torbox.js";
import type { DebridResolver } from "./types.js";

// Priority order matches CLAUDE.md §3 Rule 7's listing — used only when a
// user has more than one service configured and enabled.
const RESOLVERS: DebridResolver[] = [
  realDebridResolver,
  allDebridResolver,
  premiumizeResolver,
  debridLinkResolver,
  torBoxResolver,
];

const RESOLVERS_BY_SERVICE: Record<DebridService, DebridResolver> = Object.fromEntries(
  RESOLVERS.map((r) => [r.service, r]),
) as Record<DebridService, DebridResolver>;

/**
 * Picks the first configured-and-enabled debrid service, in Rule 7's
 * priority order — CLAUDE.md §3: "auto-detection of what the user
 * configured." Returns null if nothing is set up (webtorrent fallback
 * applies instead, per the same rule).
 */
export function getConfiguredResolver(db: Database): { resolver: DebridResolver; apiKey: string } | null {
  for (const resolver of RESOLVERS) {
    const account = getDebridAccount(db, resolver.service);
    if (account?.enabled) return { resolver, apiKey: account.apiKey };
  }
  return null;
}

export function resolverForService(service: DebridService): DebridResolver {
  return RESOLVERS_BY_SERVICE[service];
}
