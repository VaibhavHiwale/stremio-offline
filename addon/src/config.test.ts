import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeConfig, encodeConfig } from "./config.js";

test("round-trips a config object through base64url", () => {
  const encoded = encodeConfig({ debridKey: "abc123" });
  assert.deepEqual(decodeConfig(encoded), { debridKey: "abc123" });
});

test("decodeConfig tolerates garbage input", () => {
  assert.deepEqual(decodeConfig("not-valid-base64url!!"), {});
});
