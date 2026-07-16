const UINT32_RANGE = 0x1_0000_0000;

/** Stable, non-cryptographic hash for turning authored string ids into RNG seeds. */
export function hashSeed(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

export type RandomSeed = number | string;

/**
 * Small deterministic PRNG based on Mulberry32. Gameplay code should use this
 * instead of Math.random so a numeric seed and state always reproduce a run.
 */
export class SeededRandom {
  private state: number;

  public constructor(seed: RandomSeed) {
    this.state = normalizeSeed(seed);
  }

  public static fromState(state: number): SeededRandom {
    return new SeededRandom(state);
  }

  public getState(): number {
    return this.state >>> 0;
  }

  public setState(state: number): void {
    assertUint32(state, 'state');
    this.state = state >>> 0;
  }

  public nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  /** Returns a value in the half-open range [0, 1). */
  public next(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  /** Returns a floating-point value in the half-open range [min, max). */
  public range(min: number, max: number): number {
    assertFinite(min, 'min');
    assertFinite(max, 'max');
    if (max <= min) {
      throw new RangeError('max must be greater than min');
    }

    return min + this.next() * (max - min);
  }

  /** Returns an integer in the half-open range [min, max). */
  public integer(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
      throw new TypeError('integer bounds must be safe integers');
    }
    if (max <= min) {
      throw new RangeError('max must be greater than min');
    }

    return min + Math.floor(this.next() * (max - min));
  }

  public chance(probability: number): boolean {
    assertFinite(probability, 'probability');
    if (probability < 0 || probability > 1) {
      throw new RangeError('probability must be between 0 and 1');
    }

    return this.next() < probability;
  }

  public pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new RangeError('cannot pick from an empty collection');
    }

    const value = values[this.integer(0, values.length)];
    if (value === undefined) {
      throw new Error('random selection was unexpectedly out of range');
    }
    return value;
  }

  /** Returns a shuffled copy and never mutates the supplied collection. */
  public shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.integer(0, index + 1);
      const current = result[index];
      const replacement = result[swapIndex];
      if (current === undefined || replacement === undefined) {
        throw new Error('shuffle index was unexpectedly out of range');
      }
      result[index] = replacement;
      result[swapIndex] = current;
    }
    return result;
  }

  /** Creates a deterministic independent stream without advancing this one. */
  public fork(label: string): SeededRandom {
    return new SeededRandom(hashSeed(`${this.state}:${label}`));
  }
}

function normalizeSeed(seed: RandomSeed): number {
  if (typeof seed === 'string') {
    return hashSeed(seed);
  }
  assertUint32(seed, 'seed');
  return seed >>> 0;
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= UINT32_RANGE) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
}
