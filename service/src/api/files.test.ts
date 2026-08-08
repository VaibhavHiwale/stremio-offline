import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRangeHeader } from "./files.js";

const SIZE = 1000;

test("open-ended range: bytes=500-", () => {
  assert.deepEqual(parseRangeHeader("bytes=500-", SIZE), [{ start: 500, end: 999 }]);
});

test("bounded range: bytes=0-499", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-499", SIZE), [{ start: 0, end: 499 }]);
});

test("suffix range: bytes=-100 (last 100 bytes)", () => {
  assert.deepEqual(parseRangeHeader("bytes=-100", SIZE), [{ start: 900, end: 999 }]);
});

test("suffix range larger than file clamps to start of file", () => {
  assert.deepEqual(parseRangeHeader("bytes=-5000", SIZE), [{ start: 0, end: 999 }]);
});

test("end beyond file size clamps to last byte", () => {
  assert.deepEqual(parseRangeHeader("bytes=900-9999", SIZE), [{ start: 900, end: 999 }]);
});

test("multi-range request parses all parts", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-99,200-299,-50", SIZE), [
    { start: 0, end: 99 },
    { start: 200, end: 299 },
    { start: 950, end: 999 },
  ]);
});

test("start beyond file size is unsatisfiable", () => {
  assert.equal(parseRangeHeader("bytes=1000-1100", SIZE), null);
});

test("malformed header returns null", () => {
  assert.equal(parseRangeHeader("bytes=abc-def", SIZE), null);
  assert.equal(parseRangeHeader("nonsense", SIZE), null);
});
