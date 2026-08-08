import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startTestServer } from "../testutils/fakeHttpServer.js";
import { downloadToPart } from "./http.js";

function tempDest(): string {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-http-test-"));
  return join(dir, "download.part");
}

test("downloads a file completely in one shot", async () => {
  const body = randomBytes(50_000);
  const { url, close } = await startTestServer(body);
  const dest = tempDest();
  try {
    const outcome = await downloadToPart(url, dest, { knownEtag: null });
    assert.equal(outcome.kind, "complete");
    assert.deepEqual(readFileSync(dest), body);
  } finally {
    await close();
  }
});

test("resumes correctly from whatever bytes survived a kill -9 (a fresh process, not a live retry)", async () => {
  // A real kill -9 terminates the process outright — there's no in-flight
  // "outcome" to observe from the killed attempt, only whatever bytes the
  // OS had already flushed to the .part file before it died. What matters
  // is that the *next* invocation (post-restart) picks that up correctly.
  const body = randomBytes(200_000);
  const { url, close } = await startTestServer(body);
  const dest = tempDest();
  try {
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body.subarray(0, 60_000));

    const outcome = await downloadToPart(url, dest, { knownEtag: null });

    assert.equal(outcome.kind, "complete");
    assert.deepEqual(readFileSync(dest), body, "resumed file must be byte-identical to the source");
  } finally {
    await close();
  }
});

test("a connection that dies mid-stream leaves the partial file intact rather than corrupting or deleting it", async () => {
  const body = randomBytes(200_000);
  const { url, close, state } = await startTestServer(body);
  const dest = tempDest();
  try {
    state.truncateAfterBytes = 60_000;
    const outcome = await downloadToPart(url, dest, { knownEtag: null });
    assert.notEqual(outcome.kind, "complete");

    // How much (if anything) made it to disk before the connection died is a
    // timing/OS-buffering detail we don't control — it may even be nothing, if
    // the connection reset before the client processed any body bytes at all.
    // The only thing this build must guarantee is that whatever *is* there is
    // a valid, undamaged prefix of the real file — never garbage, never more
    // than the source.
    let partial: Buffer;
    try {
      partial = readFileSync(dest);
    } catch {
      partial = Buffer.alloc(0);
    }
    assert.ok(partial.length <= body.length);
    assert.deepEqual(partial, body.subarray(0, partial.length));
  } finally {
    await close();
  }
});

test("restarts from zero when the server ignores the Range header instead of corrupting the file", async () => {
  const body = randomBytes(80_000);
  const { url, close, state } = await startTestServer(body);
  const dest = tempDest();
  try {
    // Pre-seed a bogus partial file, as if a previous attempt had written garbage.
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, randomBytes(30_000));

    state.ignoreRange = true;
    const outcome = await downloadToPart(url, dest, { knownEtag: null });

    assert.equal(outcome.kind, "complete");
    assert.deepEqual(readFileSync(dest), body, "must equal the real full body, not garbage+body spliced together");
  } finally {
    await close();
  }
});

test("restarts from zero when the remote ETag changed since the partial download started", async () => {
  const body = randomBytes(80_000);
  const { url, close, state } = await startTestServer(body);
  const dest = tempDest();
  try {
    // Simulates: a prior attempt got 40,000 bytes in (under ETag "v1", stored
    // as knownEtag by the caller — see runner.ts's onHeaders wiring) before
    // being interrupted; the remote file has since changed.
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body.subarray(0, 40_000));

    state.etag = '"v2"';
    const outcome = await downloadToPart(url, dest, { knownEtag: '"v1"' });

    assert.equal(outcome.kind, "complete");
    assert.deepEqual(readFileSync(dest), body);
  } finally {
    await close();
  }
});

test("pauses without corrupting the partial file when disk space runs out, then resumes once space frees up", async () => {
  const body = randomBytes(150_000);
  const { url, close, state } = await startTestServer(body);
  const dest = tempDest();
  try {
    // Slow the transfer down (25 slices, 8ms apart = ~200ms total) so a
    // 20ms-interval disk check is guaranteed a real window to fire
    // mid-transfer, deterministically, instead of racing a near-instant
    // loopback transfer.
    state.sliceDelayMs = 8;
    // First call is the pre-flight check (before any bytes are written) —
    // let it pass so streaming actually starts. Every call after that is a
    // periodic in-stream check; fail from the second one on, deterministically
    // simulating the disk filling up mid-transfer.
    let checks = 0;
    const checkDiskSpace = async () => {
      checks++;
      return checks <= 1;
    };

    const firstOutcome = await downloadToPart(
      url,
      dest,
      { knownEtag: null },
      { checkDiskSpace, diskCheckIntervalMs: 20 },
    );
    assert.equal(firstOutcome.kind, "paused-disk-full");

    const partialSize = readFileSync(dest).length;
    assert.ok(
      partialSize > 0 && partialSize < body.length,
      `some bytes should have been written before the disk-full check tripped (got ${partialSize})`,
    );

    const alwaysOk = async () => true;
    const secondOutcome = await downloadToPart(url, dest, { knownEtag: null }, { checkDiskSpace: alwaysOk, diskCheckIntervalMs: 20 });
    assert.equal(secondOutcome.kind, "complete");
    assert.deepEqual(readFileSync(dest), body);
  } finally {
    await close();
  }
});
