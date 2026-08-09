import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordError } from "./errorLog.js";
import { generateWeeklyRollupMarkdown, isWeeklyRollupDue, persistWeeklyRollup, weeklyRollupPath } from "./weeklyRollup.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "stremio-offline-rollup-test-"));
}

test("generateWeeklyRollupMarkdown reports 'no errors' when the log is empty", () => {
  const markdown = generateWeeklyRollupMarkdown([]);
  assert.match(markdown, /No errors recorded/);
});

test("groups by component + error type, most frequent first", () => {
  const records = [
    { timestamp: "2026-01-01T00:00:00.000Z", component: "scheduler", errorType: "TypeError", message: "a", installIdHash: "x" },
    { timestamp: "2026-01-01T00:00:01.000Z", component: "scheduler", errorType: "TypeError", message: "b", installIdHash: "x" },
    { timestamp: "2026-01-01T00:00:02.000Z", component: "scheduler", errorType: "TypeError", message: "c (latest)", installIdHash: "x" },
    { timestamp: "2026-01-01T00:00:00.000Z", component: "remuxRunner", errorType: "Error", message: "d", installIdHash: "x" },
  ];

  const markdown = generateWeeklyRollupMarkdown(records);
  const schedulerLine = markdown.split("\n").find((l) => l.includes("scheduler"))!;
  const remuxLine = markdown.split("\n").find((l) => l.includes("remuxRunner"))!;

  assert.ok(markdown.indexOf(schedulerLine) < markdown.indexOf(remuxLine), "the 3x group should sort before the 1x group");
  assert.match(schedulerLine, /\| 3 \|/);
  assert.match(schedulerLine, /c \(latest\)/, "should show the most recent message for the group");
});

test("escapes pipe characters in messages so the markdown table doesn't break", () => {
  const markdown = generateWeeklyRollupMarkdown([
    { timestamp: "2026-01-01T00:00:00.000Z", component: "rest", errorType: "Error", message: "a | b | c", installIdHash: "x" },
  ]);
  assert.match(markdown, /a \\\| b \\\| c/);
});

test("persistWeeklyRollup writes the file and it round-trips through generateWeeklyRollupMarkdown", async () => {
  const dir = freshDir();
  recordError(dir, "scheduler", new Error("boom"), { installIdHash: "x" });

  const markdown = await persistWeeklyRollup(dir);
  assert.equal(existsSync(weeklyRollupPath(dir)), true);
  assert.equal(readFileSync(weeklyRollupPath(dir), "utf8"), markdown);
  assert.match(markdown, /scheduler/);
});

test("isWeeklyRollupDue is true when no summary exists yet", async () => {
  const dir = freshDir();
  assert.equal(await isWeeklyRollupDue(dir), true);
});

test("isWeeklyRollupDue is false right after persisting, true again once 7+ days have passed", async () => {
  const dir = freshDir();
  await persistWeeklyRollup(dir);
  assert.equal(await isWeeklyRollupDue(dir), false);

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(weeklyRollupPath(dir), eightDaysAgo, eightDaysAgo);
  assert.equal(await isWeeklyRollupDue(dir), true);
});
