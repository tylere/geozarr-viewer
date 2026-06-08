/** A decoded chunk held in CPU memory: the raw typed array for *all* frames of
 * a texture-array dimension (e.g. all 120 SILAM `step`s), plus its 3-D shape. */
export type DecodedChunk = {
  /** Raw decoded data, row-major `[depth, height, width]`. Kept in its native
   * dtype (e.g. Float16Array) so RAM ≈ the uncompressed chunk, not 2× for f32. */
  data: ArrayLike<number>;
  depth: number;
  height: number;
  width: number;
  byteLength: number;
};

/**
 * Module-level LRU of decoded chunks, bounded by total bytes.
 *
 * Texture-array dims whose frames don't all fit the GPU budget are loaded a
 * window at a time, and each window crossing would otherwise re-decompress the
 * whole (single) chunk. Memoizing the decoded chunk here means it's decoded
 * once per (variable + pinned-dims + spatial tile); every window and re-visited
 * frame is then a cheap RAM slice. Keyed by an opaque string the caller builds.
 */
class ChunkCache {
  private map = new Map<string, DecodedChunk>();
  private bytes = 0;
  private readonly maxBytes: number;
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(key: string): DecodedChunk | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // Refresh recency: delete + re-insert moves it to the end.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: DecodedChunk): void {
    const existing = this.map.get(key);
    if (existing) this.bytes -= existing.byteLength;
    this.map.set(key, value);
    this.bytes += value.byteLength;
    // Evict least-recently-used (front of insertion order) until under budget.
    // Always keep at least one entry so a single chunk larger than the budget
    // still works (it just won't share with others).
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.bytes -= evicted.byteLength;
    }
  }
}

/** ~600 MB: comfortably holds one SILAM-sized chunk (~387 MB raw float16) plus
 * headroom, while bounding worst-case RAM. */
export const decodedChunkCache = new ChunkCache(600 * 1e6);
