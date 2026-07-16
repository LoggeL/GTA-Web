export function hashSeed(seed: number | string): number {
  if (typeof seed === 'number') {
    return seed >>> 0;
  }

  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export class SeededRandom {
  private state: number;

  public constructor(seed: number | string) {
    this.state = hashSeed(seed);
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  public range(minimum: number, maximum: number): number {
    return minimum + (maximum - minimum) * this.next();
  }

  public integer(minimum: number, maximumInclusive: number): number {
    return Math.floor(this.range(minimum, maximumInclusive + 1));
  }

  public pick<T>(values: readonly T[]): T {
    const value = values[this.integer(0, values.length - 1)];
    if (value === undefined) {
      throw new Error('Cannot pick from an empty collection');
    }
    return value;
  }
}

