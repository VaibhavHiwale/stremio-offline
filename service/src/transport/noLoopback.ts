const LOOPBACK_PATTERNS = [/127\.0\.0\.1/, /\blocalhost\b/i, /::1\b/];

/**
 * Recursively scans a JSON-serializable value for loopback hostnames. Every
 * manifest/catalog/meta/stream payload we hand to a client must pass this —
 * see CLAUDE.md §3 Rule 3. Returns the offending strings, if any.
 */
export function findLoopbackReferences(value: unknown, path = "$"): string[] {
  const hits: string[] = [];

  if (typeof value === "string") {
    if (LOOPBACK_PATTERNS.some((re) => re.test(value))) {
      hits.push(`${path}: ${value}`);
    }
    return hits;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findLoopbackReferences(item, `${path}[${i}]`)));
    return hits;
  }

  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      hits.push(...findLoopbackReferences(val, `${path}.${key}`));
    }
  }

  return hits;
}

export function assertNoLoopback(value: unknown, label: string): void {
  const hits = findLoopbackReferences(value);
  if (hits.length > 0) {
    throw new Error(`${label} contains loopback reference(s):\n${hits.join("\n")}`);
  }
}
