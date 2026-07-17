import {
  SOLARA_DISTRICTS,
  SOLARA_DISTRICT_IDS,
  resolveSolaraPosition,
  solaraCoordinateSalt,
} from '../core/districts';
import type {
  CollectibleCategoryId,
  CollectibleDefinition,
  CollectibleSetDefinition,
  ItemGrant,
} from './types';

export const DEFAULT_COLLECTIBLE_SEED = 0x534f4c41;

const COMPONENT_IDS = [
  'component-scrap',
  'component-cloth',
  'component-chemicals',
  'component-electronics',
  'component-powder',
] as const;

interface CategoryGenerationRule {
  readonly category: CollectibleCategoryId;
  readonly count: number;
  readonly displayName: string;
  readonly revealRule: CollectibleDefinition['revealRule'];
  readonly xp: number;
  readonly cash: number;
}

const GENERATION_RULES: readonly CategoryGenerationRule[] = [
  {
    category: 'salvage-cache',
    count: 30,
    displayName: 'Salvage Cache',
    revealRule: 'nearby',
    xp: 75,
    cash: 45,
  },
  {
    category: 'stunt-jump',
    count: 20,
    displayName: 'Stunt Jump',
    revealRule: 'road-survey',
    xp: 110,
    cash: 180,
  },
  {
    category: 'signal-node',
    count: 10,
    displayName: 'Signal Node',
    revealRule: 'signal-scan',
    xp: 150,
    cash: 90,
  },
];

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function roundCoordinate(value: number): number {
  return Math.round(value * 10) / 10;
}

function preferredDistrictCoordinate(
  minimum: number,
  maximum: number,
  random: () => number,
): number {
  const margin = 32;
  return minimum + margin + random() * (maximum - minimum - margin * 2);
}

function collectibleItems(category: CollectibleCategoryId, ordinal: number): readonly ItemGrant[] {
  switch (category) {
    case 'salvage-cache': {
      const itemId = COMPONENT_IDS[(ordinal - 1) % COMPONENT_IDS.length];
      return itemId === undefined ? [] : [{ itemId, quantity: ordinal % 5 === 0 ? 2 : 1 }];
    }
    case 'stunt-jump':
      return ordinal % 5 === 0 ? [{ itemId: 'vehicle-repair-kit', quantity: 1 }] : [];
    case 'signal-node':
      return [{ itemId: 'component-electronics', quantity: 2 }];
  }
}

export function generateCollectibles(seed: number = DEFAULT_COLLECTIBLE_SEED): readonly CollectibleDefinition[] {
  const random = createRandom(seed);
  const definitions: CollectibleDefinition[] = [];
  const occupiedPositions = new Set<string>();
  let globalOrdinal = 0;

  for (const rule of GENERATION_RULES) {
    for (let ordinal = 1; ordinal <= rule.count; ordinal += 1) {
      const districtId = SOLARA_DISTRICT_IDS[globalOrdinal % SOLARA_DISTRICT_IDS.length];
      if (districtId === undefined) {
        throw new Error('Collectible district table is empty.');
      }
      const district = SOLARA_DISTRICTS[districtId];
      const intent = rule.category === 'stunt-jump' ? 'road' : 'sidewalk';
      let resolved: { readonly x: number; readonly z: number } | null = null;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const preferred = {
          x: preferredDistrictCoordinate(district.minX, district.maxX, random),
          z: preferredDistrictCoordinate(district.minZ, district.maxZ, random),
        };
        const candidate = resolveSolaraPosition(
          districtId,
          preferred,
          intent,
          solaraCoordinateSalt(`${seed}:${rule.category}:${ordinal}:${attempt}`),
        );
        const key = `${candidate.x.toFixed(1)}:${candidate.z.toFixed(1)}`;
        if (!occupiedPositions.has(key)) {
          occupiedPositions.add(key);
          resolved = candidate;
          break;
        }
      }
      if (resolved === null) {
        throw new Error(`Unable to place unique collectible ${rule.category}-${ordinal}`);
      }
      const y = rule.category === 'signal-node' ? 3 + Math.floor(random() * 10) : 0;
      const suffix = ordinal.toString().padStart(2, '0');

      definitions.push({
        id: `${rule.category}-${suffix}`,
        category: rule.category,
        ordinal,
        name: `${rule.displayName} ${suffix}`,
        district: districtId,
        position: {
          district: districtId,
          x: roundCoordinate(resolved.x),
          y,
          z: roundCoordinate(resolved.z),
        },
        revealRule: rule.revealRule,
        reward: {
          xp: rule.xp,
          cash: rule.cash,
          items: collectibleItems(rule.category, ordinal),
        },
      });
      globalOrdinal += 1;
    }
  }

  return definitions;
}

export const COLLECTIBLES = generateCollectibles();

export const COLLECTIBLE_SETS: readonly CollectibleSetDefinition[] = [
  {
    category: 'salvage-cache',
    count: 30,
    completionReward: { xp: 1000, cash: 1200, unlockFlag: 'salvage-cache-set-complete' },
  },
  {
    category: 'stunt-jump',
    count: 20,
    completionReward: { xp: 1400, cash: 2400, unlockFlag: 'stunt-jump-set-complete' },
  },
  {
    category: 'signal-node',
    count: 10,
    completionReward: { xp: 1800, cash: 1600, unlockFlag: 'signal-node-set-complete' },
  },
] as const satisfies readonly CollectibleSetDefinition[];
