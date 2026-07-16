import { describe, expect, it } from 'vitest';

import type { ItemDefinition } from '../../src/data/types';
import {
  applyDefeatPenalty,
  beginWantedSearch,
  clearWanted,
  createWantedState,
  escalateWanted,
  policeResponseForLevel,
  reportCrime,
  tickWanted,
  wantedLevelForHeat,
} from '../../src/systems/wanted';

const ITEMS: readonly ItemDefinition[] = [
  {
    id: 'contraband', name: 'Bonds', description: '', category: 'contraband',
    shape: { width: 1, height: 1 }, weightKg: 0.1, maximumStack: 5,
    baseValue: 100, hasDurability: false, discardable: true,
  },
  {
    id: 'quest', name: 'Ledger', description: '', category: 'quest',
    shape: { width: 1, height: 1 }, weightKg: 0, maximumStack: 1,
    baseValue: 0, hasDurability: false, discardable: false,
  },
];

const BASE_MODIFIERS = { nerve: 1 } as const;

describe('wanted system', () => {
  it('turns witness reports into investigation or pursuit state', () => {
    const investigating = reportCrime(
      createWantedState(),
      { baseHeat: 10, suspectIdentified: false },
      BASE_MODIFIERS,
    );
    expect(investigating).toEqual(expect.objectContaining({
      level: 1, phase: 'investigating', heat: 10,
    }));

    const pursuit = reportCrime(
      createWantedState(),
      { baseHeat: 30, suspectIdentified: true },
      BASE_MODIFIERS,
    );
    expect(pursuit.level).toBe(2);
    expect(pursuit.phase).toBe('pursuit');
  });

  it('applies Nerve and Rule heat modifiers deterministically', () => {
    const base = reportCrime(createWantedState(), {
      baseHeat: 100, suspectIdentified: true,
    }, BASE_MODIFIERS);
    const nerve = reportCrime(createWantedState(), {
      baseHeat: 100, suspectIdentified: true,
    }, { nerve: 6 });
    const rule = reportCrime(createWantedState(), {
      baseHeat: 100, suspectIdentified: true,
    }, { nerve: 1, ending: 'rule' });

    expect(base.heat).toBe(100);
    expect(nerve.heat).toBe(75);
    expect(rule.heat).toBeCloseTo(110);
    expect(nerve.level).toBe(3);
    expect(rule.level).toBe(4);
  });

  it('supports authored escalation through all five response levels', () => {
    let state = createWantedState();
    for (const level of [1, 2, 3, 4, 5] as const) {
      state = escalateWanted(state, level, BASE_MODIFIERS);
      expect(state.level).toBe(level);
      expect(wantedLevelForHeat(state.heat)).toBe(level);
    }
    expect(policeResponseForLevel(1)).toEqual(['foot-patrols']);
    expect(policeResponseForLevel(3)).toEqual(expect.arrayContaining([
      'roadblocks', 'tire-strips', 'flank-cars',
    ]));
    expect(policeResponseForLevel(5)).toEqual(expect.arrayContaining([
      'helicopter-spotlight', 'marksmen', 'reinforced-roadblocks',
    ]));
    expect(policeResponseForLevel(5)).not.toContain('military');
  });

  it('searches after line of sight breaks and clears after unseen time', () => {
    const pursuit = escalateWanted(createWantedState(), 2, BASE_MODIFIERS);
    const searching = tickWanted(pursuit, 1, {
      isVisible: false,
      insideSearchArea: true,
    }, BASE_MODIFIERS);
    expect(searching.phase).toBe('search');
    expect(searching.searchSecondsRemaining).toBe(34);

    const visible = tickWanted(searching, 10, {
      isVisible: true,
      insideSearchArea: true,
    }, BASE_MODIFIERS);
    expect(visible.phase).toBe('pursuit');
    expect(visible.searchSecondsRemaining).toBe(35);

    const cleared = tickWanted(searching, 30, {
      isVisible: false,
      insideSearchArea: false,
    }, BASE_MODIFIERS);
    expect(cleared).toEqual(clearWanted());

    const exhaustedInside = tickWanted(searching, 60, {
      isVisible: false,
      insideSearchArea: true,
    }, BASE_MODIFIERS);
    expect(exhaustedInside).toEqual(expect.objectContaining({
      level: 2,
      phase: 'search',
      searchSecondsRemaining: 0,
    }));
    expect(tickWanted(exhaustedInside, 0, {
      isVisible: false,
      insideSearchArea: false,
    }, BASE_MODIFIERS)).toEqual(clearWanted());
  });

  it('reduces search duration after the Expose ending', () => {
    const levelOne = escalateWanted(createWantedState(), 1, BASE_MODIFIERS);
    const ordinary = beginWantedSearch(levelOne, BASE_MODIFIERS);
    const expose = beginWantedSearch(levelOne, { nerve: 1, ending: 'expose' });

    expect(ordinary.searchSecondsRemaining).toBe(25);
    expect(expose.searchSecondsRemaining).toBe(20);
  });

  it('applies death/arrest cash and contraband penalties while preserving progress items', () => {
    const inventory = {
      gridWidth: 2,
      gridHeight: 1,
      maxWeightKg: 10,
      items: [
        { instanceId: 'bonds', definitionId: 'contraband', quantity: 3, durability: 100, x: 0, y: 0, rotated: false },
        { instanceId: 'ledger', definitionId: 'quest', quantity: 1, durability: 100, x: 1, y: 0, rotated: false },
      ],
    };
    const death = applyDefeatPenalty({ cash: 1_234, inventory }, ITEMS, 'death');
    const arrest = applyDefeatPenalty({ cash: 1_234, inventory }, ITEMS, 'arrest');

    expect(death.cashLost).toBe(123);
    expect(death.cash).toBe(1_111);
    expect(death.contrabandRemoved).toBe(3);
    expect(death.inventory.items.map((item) => item.definitionId)).toEqual(['quest']);
    expect(death.respawn).toBe('clinic');
    expect(arrest.respawn).toBe('station');
    expect(death.wanted).toEqual(createWantedState());
    expect(inventory.items).toHaveLength(2);
  });

  it('rejects invalid time and modifier inputs', () => {
    expect(() => tickWanted(createWantedState(), -1, {
      isVisible: false, insideSearchArea: false,
    }, BASE_MODIFIERS)).toThrow(RangeError);
    expect(() => reportCrime(createWantedState(), {
      baseHeat: 10, suspectIdentified: false,
    }, { nerve: 7 })).toThrow(RangeError);
  });
});
