import type {
  CollectibleCategoryId,
  CollectibleDefinition,
  CollectibleSetDefinition,
  DistrictId,
  ItemGrant,
} from './types';

export const DEFAULT_COLLECTIBLE_SEED = 0x534f4c41;

const DISTRICTS: readonly {
  readonly id: DistrictId;
  readonly centerX: number;
  readonly centerZ: number;
  readonly radiusX: number;
  readonly radiusZ: number;
}[] = [
  { id: 'neon-strand', centerX: -230, centerZ: 70, radiusX: 125, radiusZ: 105 },
  { id: 'alta-vista', centerX: 105, centerZ: 80, radiusX: 130, radiusZ: 120 },
  { id: 'arroyo-heights', centerX: 190, centerZ: 285, radiusX: 145, radiusZ: 95 },
  { id: 'breakwater', centerX: 105, centerZ: -235, radiusX: 165, radiusZ: 100 },
];

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
  let globalOrdinal = 0;

  for (const rule of GENERATION_RULES) {
    for (let ordinal = 1; ordinal <= rule.count; ordinal += 1) {
      const district = DISTRICTS[globalOrdinal % DISTRICTS.length];
      if (district === undefined) {
        throw new Error('Collectible district table is empty.');
      }

      const angle = random() * Math.PI * 2;
      const radius = 0.28 + random() * 0.72;
      const x = district.centerX + Math.cos(angle) * district.radiusX * radius;
      const z = district.centerZ + Math.sin(angle) * district.radiusZ * radius;
      const y = rule.category === 'signal-node' ? 3 + Math.floor(random() * 10) : 0;
      const suffix = ordinal.toString().padStart(2, '0');

      definitions.push({
        id: `${rule.category}-${suffix}`,
        category: rule.category,
        ordinal,
        name: `${rule.displayName} ${suffix}`,
        district: district.id,
        position: {
          district: district.id,
          x: roundCoordinate(x),
          y,
          z: roundCoordinate(z),
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
