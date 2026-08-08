import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Computed as a separate pass over the completed file, not incrementally during a possibly-resumed download — simpler and correct regardless of how many resumes it took to assemble the file. */
export function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
