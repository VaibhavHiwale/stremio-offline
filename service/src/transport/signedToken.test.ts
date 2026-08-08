import assert from "node:assert/strict";
import { test } from "node:test";
import { signFileToken, verifyFileToken } from "./signedToken.js";

test("a freshly signed token verifies", () => {
  const { token, expiresAt } = signFileToken("secret", "item-1", 60);
  assert.equal(verifyFileToken("secret", "item-1", expiresAt, token), true);
});

test("rejects a token for a different id", () => {
  const { token, expiresAt } = signFileToken("secret", "item-1", 60);
  assert.equal(verifyFileToken("secret", "item-2", expiresAt, token), false);
});

test("rejects a token signed with a different secret", () => {
  const { token, expiresAt } = signFileToken("secret-a", "item-1", 60);
  assert.equal(verifyFileToken("secret-b", "item-1", expiresAt, token), false);
});

test("rejects an expired token", () => {
  const { token } = signFileToken("secret", "item-1", -10);
  const pastExpiry = Math.floor(Date.now() / 1000) - 5;
  assert.equal(verifyFileToken("secret", "item-1", pastExpiry, token), false);
});

test("rejects a malformed token string without throwing", () => {
  const { expiresAt } = signFileToken("secret", "item-1", 60);
  assert.equal(verifyFileToken("secret", "item-1", expiresAt, "not-hex-!!"), false);
});
