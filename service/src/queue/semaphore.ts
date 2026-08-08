/**
 * A plain counting semaphore — CLAUDE.md §4: "Remux is a *separate*
 * semaphore sized to min(2, cpus-1) — ffmpeg transcodes will starve
 * downloads otherwise." This bounds concurrent ffmpeg processes; it isn't
 * the download scheduler (that's P5).
 */
export class Semaphore {
  private readonly limit: number;
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(limit: number) {
    if (limit < 1) throw new Error("Semaphore limit must be at least 1");
    this.limit = limit;
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.available--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }

  get inUse(): number {
    return this.limit - this.available;
  }
}
