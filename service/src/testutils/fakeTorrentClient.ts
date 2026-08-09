import { EventEmitter } from "node:events";
import type { TorrentFileLike, TorrentLike, WebTorrentClientLike } from "../downloaders/torrent.js";

export class FakeTorrentFile extends EventEmitter implements TorrentFileLike {
  downloaded = 0;
  selected = false;
  constructor(
    readonly name: string,
    readonly path: string,
    readonly length: number,
  ) {
    super();
  }
  select(): void {
    this.selected = true;
  }
  deselect(): void {
    this.selected = false;
  }
}

export class FakeTorrent extends EventEmitter implements TorrentLike {
  destroyed = false;
  destroyedWithStore: boolean | undefined;
  constructor(
    readonly files: FakeTorrentFile[],
    readonly path: string,
  ) {
    super();
  }
  destroy(opts?: { destroyStore?: boolean }): void {
    this.destroyed = true;
    this.destroyedWithStore = opts?.destroyStore;
  }
}

export class FakeWebTorrentClient extends EventEmitter implements WebTorrentClientLike {
  destroyed = false;
  /** Resolves once add()'s callback (and therefore torrent.ts's listener attachment inside it) has run — lets tests await a real signal instead of guessing timing with setImmediate/setTimeout. */
  readonly whenAdded: Promise<void>;
  private resolveAdded!: () => void;

  constructor(private readonly torrent: FakeTorrent) {
    super();
    this.whenAdded = new Promise((resolve) => {
      this.resolveAdded = resolve;
    });
  }
  add(_magnetUri: string, _opts: { path: string }, cb: (torrent: TorrentLike) => void): void {
    cb(this.torrent);
    this.resolveAdded();
  }
  destroy(): void {
    this.destroyed = true;
  }
}
