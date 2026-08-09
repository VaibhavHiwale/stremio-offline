import { open, stat } from "node:fs/promises";

const CHUNK_SIZE = 65536; // 64KB
const MIN_FILE_SIZE = CHUNK_SIZE * 2; // the reference algorithm is only defined for files at least this large

function sumInt64LE(buffer: Buffer): bigint {
  let sum = 0n;
  for (let offset = 0; offset < buffer.length; offset += 8) {
    sum += buffer.readBigUInt64LE(offset);
  }
  return sum;
}

/**
 * The classic OpenSubtitles/Stremio 64-bit file hash: file size plus the
 * sum of the first and last 64KB read as little-endian 64-bit words,
 * wrapped to 64 bits. CLAUDE.md §10 P11: this is what goes into a stream's
 * `behaviorHints.videoHash` so Stremio's own resume feature recognizes the
 * same file across sessions — nothing to do with subtitle lookup (P7 uses
 * IMDb-id search, not hash matching).
 *
 * Returns null for files under 128KB — the reference algorithm has no
 * defined behavior below that size. A real movie/episode file is always
 * far larger; this only ever affects tiny synthetic test fixtures.
 */
export async function computeVideoHash(filePath: string): Promise<string | null> {
  const { size } = await stat(filePath);
  if (size < MIN_FILE_SIZE) return null;

  const handle = await open(filePath, "r");
  try {
    const MASK = (1n << 64n) - 1n;
    let hash = BigInt(size) & MASK;

    const head = Buffer.alloc(CHUNK_SIZE);
    await handle.read(head, 0, CHUNK_SIZE, 0);
    hash = (hash + sumInt64LE(head)) & MASK;

    const tail = Buffer.alloc(CHUNK_SIZE);
    await handle.read(tail, 0, CHUNK_SIZE, size - CHUNK_SIZE);
    hash = (hash + sumInt64LE(tail)) & MASK;

    return hash.toString(16).padStart(16, "0");
  } finally {
    await handle.close();
  }
}
