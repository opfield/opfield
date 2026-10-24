/** Seeded PRNG (mulberry32 over an FNV-1a hash of the seed) so a failing run repeats with the same SEED. */
export class Rng {
  private state: number;

  constructor(seed: string) {
    let hash = 0x811c9dc5;
    for (const char of seed) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    this.state = hash || 1;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }

  /** Independent stream for one lane, so adding a lane does not reshuffle another lane's choices. */
  fork(label: string) {
    return new Rng(`${this.state}:${label}`);
  }
}
