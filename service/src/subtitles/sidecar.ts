import { promises as fsp } from "node:fs";
import { extname, join, dirname, basename } from "node:path";

/** Only ever generated from a known-good language code list — see fetchForItem.ts's LANG_CODE_RE — but re-checked here too since a bad sidecar path could otherwise escape the library directory. */
const SAFE_LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/**
 * `The Matrix (1999).mp4` + lang `en` → `The Matrix (1999).en.srt` — matches
 * the official local-files addon's convention referenced in CLAUDE.md §7's
 * library layout example.
 */
export function sidecarPath(videoPath: string, lang: string): string {
  if (!SAFE_LANG_RE.test(lang)) throw new Error(`invalid subtitle language code: ${lang}`);
  const base = basename(videoPath, extname(videoPath));
  return join(dirname(videoPath), `${base}.${lang}.srt`);
}

export async function writeSidecar(path: string, content: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(path, content, "utf8");
}
