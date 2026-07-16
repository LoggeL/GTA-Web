import { describe, expect, it } from 'vitest';

import { SeededRandom, hashSeed } from '../../src/core/random';

describe('SeededRandom', () => {
  it('produces a stable sequence for a numeric seed', () => {
    const random = new SeededRandom(123);

    expect(Array.from({ length: 5 }, () => random.nextUint32())).toEqual([
      3_381_219_976,
      766_838_775,
      2_127_363_934,
      993_692_063,
      1_614_012_641,
    ]);
  });

  it('restores streams from serializable state', () => {
    const first = new SeededRandom('solara:block:12');
    first.next();
    const state = first.getState();
    const expected = first.nextUint32();

    expect(SeededRandom.fromState(state).nextUint32()).toBe(expected);
    expect(hashSeed('solara:block:12')).toBe(new SeededRandom('solara:block:12').getState());
  });

  it('provides deterministic selection helpers without mutating input', () => {
    const source = ['a', 'b', 'c', 'd'];
    const left = new SeededRandom(98);
    const right = new SeededRandom(98);

    expect(left.shuffle(source)).toEqual(right.shuffle(source));
    expect(source).toEqual(['a', 'b', 'c', 'd']);
    expect(left.integer(4, 10)).toBeGreaterThanOrEqual(4);
    expect(left.integer(4, 10)).toBeLessThan(10);
  });

  it('rejects invalid bounds and probabilities', () => {
    const random = new SeededRandom(0);

    expect(() => random.range(1, 1)).toThrow(RangeError);
    expect(() => random.integer(3, 2)).toThrow(RangeError);
    expect(() => random.chance(1.1)).toThrow(RangeError);
    expect(() => random.pick([])).toThrow(RangeError);
  });
});
