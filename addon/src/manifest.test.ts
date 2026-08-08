import assert from "node:assert/strict";
import { test } from "node:test";
import { buildManifest, MOVIE_CATALOG_ID, SERIES_CATALOG_ID } from "./manifest.js";

test("requires configuration when the legal notice hasn't been accepted", () => {
  const manifest = buildManifest({ legalAccepted: false });
  assert.equal(manifest.behaviorHints?.configurationRequired, true);
});

test("doesn't require configuration once accepted", () => {
  const manifest = buildManifest({ legalAccepted: true });
  assert.equal(manifest.behaviorHints?.configurationRequired, false);
});

test("declares the two offline library catalogs", () => {
  const manifest = buildManifest({ legalAccepted: true });
  const ids = manifest.catalogs.map((c) => c.id);
  assert.deepEqual(ids, [MOVIE_CATALOG_ID, SERIES_CATALOG_ID]);
});
