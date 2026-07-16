import type { ItemDefinition } from '../data/types';
import type { EndingChoice, SavedInventory } from '../core/state';

export type WantedLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type WantedPhase = 'clear' | 'investigating' | 'pursuit' | 'search';

export interface WantedSystemState {
  level: WantedLevel;
  phase: WantedPhase;
  heat: number;
  searchSecondsRemaining: number;
}

export interface CrimeReport {
  baseHeat: number;
  suspectIdentified: boolean;
}

export interface WantedModifiers {
  nerve: number;
  ending?: EndingChoice | null;
  heatGainMultiplier?: number;
  searchDurationMultiplier?: number;
}

export interface WantedTickContext {
  isVisible: boolean;
  insideSearchArea: boolean;
}

export type PoliceResponse =
  | 'foot-patrols'
  | 'armed-officers'
  | 'cruisers'
  | 'roadblocks'
  | 'tire-strips'
  | 'flank-cars'
  | 'tactical-vans'
  | 'armored-heavies'
  | 'marksmen'
  | 'helicopter-spotlight'
  | 'reinforced-roadblocks'
  | 'aggressive-vehicle-tactics';

export interface DefeatPenaltyInput {
  cash: number;
  inventory: SavedInventory;
}

export interface DefeatPenaltyResult {
  cash: number;
  inventory: SavedInventory;
  cashLost: number;
  contrabandRemoved: number;
  respawn: 'clinic' | 'station';
  wanted: WantedSystemState;
}

export const WANTED_HEAT_THRESHOLDS: Readonly<Record<WantedLevel, number>> = {
  0: 0,
  1: 10,
  2: 30,
  3: 60,
  4: 100,
  5: 150,
};

export function createWantedState(): WantedSystemState {
  return { level: 0, phase: 'clear', heat: 0, searchSecondsRemaining: 0 };
}

export function wantedLevelForHeat(heat: number): WantedLevel {
  if (!Number.isFinite(heat) || heat < 0) {
    throw new RangeError('heat must be non-negative and finite');
  }
  if (heat >= WANTED_HEAT_THRESHOLDS[5]) return 5;
  if (heat >= WANTED_HEAT_THRESHOLDS[4]) return 4;
  if (heat >= WANTED_HEAT_THRESHOLDS[3]) return 3;
  if (heat >= WANTED_HEAT_THRESHOLDS[2]) return 2;
  if (heat >= WANTED_HEAT_THRESHOLDS[1]) return 1;
  return 0;
}

export function reportCrime(
  state: Readonly<WantedSystemState>,
  report: Readonly<CrimeReport>,
  modifiers: Readonly<WantedModifiers>,
): WantedSystemState {
  if (!Number.isFinite(report.baseHeat) || report.baseHeat < 0) {
    throw new RangeError('crime heat must be non-negative and finite');
  }
  validateModifiers(modifiers);
  const nerveMultiplier = 1 - (clamp(modifiers.nerve, 1, 6) - 1) * 0.05;
  const endingMultiplier = modifiers.ending === 'rule' ? 1.1 : 1;
  const gain = report.baseHeat
    * nerveMultiplier
    * endingMultiplier
    * (modifiers.heatGainMultiplier ?? 1);
  const heat = Math.max(0, state.heat + gain);
  const level = wantedLevelForHeat(heat);
  if (level === 0) {
    return { ...createWantedState(), heat };
  }
  const duration = searchDuration(level, modifiers);
  return {
    level,
    heat,
    phase: report.suspectIdentified
      ? 'pursuit'
      : state.phase === 'clear' ? 'investigating' : state.phase,
    searchSecondsRemaining: Math.max(state.searchSecondsRemaining, duration),
  };
}

export function escalateWanted(
  state: Readonly<WantedSystemState>,
  targetLevel: WantedLevel,
  modifiers: Readonly<WantedModifiers>,
  suspectIdentified = true,
): WantedSystemState {
  validateModifiers(modifiers);
  if (targetLevel === 0) {
    return clearWanted();
  }
  const level = Math.max(state.level, targetLevel) as WantedLevel;
  return {
    level,
    heat: Math.max(state.heat, WANTED_HEAT_THRESHOLDS[level]),
    phase: suspectIdentified ? 'pursuit' : 'investigating',
    searchSecondsRemaining: Math.max(
      state.searchSecondsRemaining,
      searchDuration(level, modifiers),
    ),
  };
}

export function confirmPoliceSighting(
  state: Readonly<WantedSystemState>,
  modifiers: Readonly<WantedModifiers>,
): WantedSystemState {
  validateModifiers(modifiers);
  if (state.level === 0) {
    return clearWanted();
  }
  return {
    ...state,
    phase: 'pursuit',
    searchSecondsRemaining: searchDuration(state.level, modifiers),
  };
}

export function beginWantedSearch(
  state: Readonly<WantedSystemState>,
  modifiers: Readonly<WantedModifiers>,
): WantedSystemState {
  validateModifiers(modifiers);
  if (state.level === 0) {
    return clearWanted();
  }
  return {
    ...state,
    phase: 'search',
    searchSecondsRemaining: searchDuration(state.level, modifiers),
  };
}

export function tickWanted(
  state: Readonly<WantedSystemState>,
  deltaSeconds: number,
  context: Readonly<WantedTickContext>,
  modifiers: Readonly<WantedModifiers>,
): WantedSystemState {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    throw new RangeError('deltaSeconds must be non-negative and finite');
  }
  validateModifiers(modifiers);
  if (state.level === 0) {
    return clearWanted();
  }
  if (context.isVisible) {
    return confirmPoliceSighting(state, modifiers);
  }

  const searching = state.phase === 'pursuit'
    ? beginWantedSearch(state, modifiers)
    : { ...state };
  const decayRate = context.insideSearchArea ? 1 : 1.5;
  const remaining = Math.max(0, searching.searchSecondsRemaining - deltaSeconds * decayRate);
  // Police may exhaust their local sweep while Alex remains inside the search
  // perimeter, but heat only clears after Alex is also outside it.
  if (remaining === 0 && !context.insideSearchArea) {
    return clearWanted();
  }
  return {
    ...searching,
    phase: searching.phase === 'investigating' ? 'investigating' : 'search',
    searchSecondsRemaining: remaining,
  };
}

export function clearWanted(): WantedSystemState {
  return createWantedState();
}

export function policeResponseForLevel(level: WantedLevel): readonly PoliceResponse[] {
  switch (level) {
    case 0:
      return [];
    case 1:
      return ['foot-patrols'];
    case 2:
      return ['foot-patrols', 'armed-officers', 'cruisers'];
    case 3:
      return ['foot-patrols', 'armed-officers', 'cruisers', 'roadblocks', 'tire-strips', 'flank-cars'];
    case 4:
      return [
        'foot-patrols',
        'armed-officers',
        'cruisers',
        'roadblocks',
        'tire-strips',
        'flank-cars',
        'tactical-vans',
        'armored-heavies',
        'marksmen',
      ];
    case 5:
      return [
        'foot-patrols',
        'armed-officers',
        'cruisers',
        'roadblocks',
        'tire-strips',
        'flank-cars',
        'tactical-vans',
        'armored-heavies',
        'marksmen',
        'helicopter-spotlight',
        'reinforced-roadblocks',
        'aggressive-vehicle-tactics',
      ];
  }
}

export function applyDefeatPenalty(
  input: Readonly<DefeatPenaltyInput>,
  definitions: readonly ItemDefinition[],
  outcome: 'death' | 'arrest',
): DefeatPenaltyResult {
  if (!Number.isSafeInteger(input.cash) || input.cash < 0) {
    throw new RangeError('cash must be a non-negative safe integer');
  }
  const catalog = new Map(definitions.map((definition) => [definition.id, definition]));
  let contrabandRemoved = 0;
  const items = input.inventory.items
    .filter((item) => {
      if (catalog.get(item.definitionId)?.category === 'contraband') {
        contrabandRemoved += item.quantity;
        return false;
      }
      return true;
    })
    .map((item) => ({ ...item }));
  const cashLost = Math.floor(input.cash * 0.1);
  return {
    cash: input.cash - cashLost,
    inventory: { ...input.inventory, items },
    cashLost,
    contrabandRemoved,
    respawn: outcome === 'death' ? 'clinic' : 'station',
    wanted: clearWanted(),
  };
}

function searchDuration(level: WantedLevel, modifiers: Readonly<WantedModifiers>): number {
  const base = 15 + level * 10;
  const endingMultiplier = modifiers.ending === 'expose' ? 0.8 : 1;
  return base * endingMultiplier * (modifiers.searchDurationMultiplier ?? 1);
}

function validateModifiers(modifiers: Readonly<WantedModifiers>): void {
  if (!Number.isFinite(modifiers.nerve) || modifiers.nerve < 1 || modifiers.nerve > 6) {
    throw new RangeError('nerve must be between 1 and 6');
  }
  for (const [name, value] of [
    ['heatGainMultiplier', modifiers.heatGainMultiplier ?? 1],
    ['searchDurationMultiplier', modifiers.searchDurationMultiplier ?? 1],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be non-negative and finite`);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
