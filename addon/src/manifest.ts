import type { Manifest } from "./protocol.js";

export const MOVIE_CATALOG_ID = "stremio-offline-movies";
export const SERIES_CATALOG_ID = "stremio-offline-series";

const CATALOG_EXTRA = [{ name: "search" }, { name: "genre" }, { name: "skip" }];

/**
 * The offline library is a catalog (Rule 5) — pure JSON, renders identically
 * everywhere. `configurationRequired` is computed dynamically from whether
 * the mandatory first-run legal notice has been accepted, so an unconfigured
 * install lands on /configure instead of a broken catalog.
 */
export function buildManifest(opts: { legalAccepted: boolean }): Manifest {
  return {
    id: "org.stremio-offline",
    version: "0.1.0",
    name: "Offline Downloads",
    description:
      "Download content your own addons and debrid account already resolve, for offline playback. " +
      "Requires a companion service you run yourself.",
    resources: ["catalog", "meta", "stream", "subtitles"],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: MOVIE_CATALOG_ID, name: "Downloaded Movies", extra: CATALOG_EXTRA },
      { type: "series", id: SERIES_CATALOG_ID, name: "Downloaded Series", extra: CATALOG_EXTRA },
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: !opts.legalAccepted,
    },
  };
}
