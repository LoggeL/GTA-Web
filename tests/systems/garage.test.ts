import { describe, expect, it } from 'vitest';

import type { SavedInventory } from '../../src/core/state';
import type { ItemDefinition } from '../../src/data/types';
import { VEHICLES } from '../../src/data/vehicles';
import {
  applyVehicleDamage,
  applyVehicleUpgrade,
  createGarageState,
  GARAGE_SLOT_COUNT,
  quoteRegistrationFee,
  quoteVehicleRepair,
  quoteVehicleUpgrade,
  registerVehicle,
  repaintVehicle,
  retrieveVehicleFromGarage,
  repairVehicle,
  replaceVehicleTrunk,
  restoreGarageSnapshot,
  snapshotGarageState,
  storeItemInTrunk,
  trunkCapacityFor,
  unlockTrunkRowBonus,
  validateGarageSnapshot,
  vehicleOperatingState,
} from '../../src/systems/garage';
import type {
  GarageSnapshotV1,
  GarageState,
  RegisterVehicleRequest,
} from '../../src/systems/garage';

const TRUNK_ITEMS: readonly ItemDefinition[] = [
  {
    id: 'cargo-box',
    name: 'Cargo Box',
    description: '',
    category: 'component',
    shape: { width: 1, height: 1 },
    weightKg: 1,
    maximumStack: 1,
    baseValue: 1,
    hasDurability: false,
    discardable: true,
  },
  {
    id: 'heavy-part',
    name: 'Heavy Part',
    description: '',
    category: 'component',
    shape: { width: 1, height: 1 },
    weightKg: 40,
    maximumStack: 1,
    baseValue: 1,
    hasDurability: false,
    discardable: true,
  },
] as const;

function mustRegister(
  state: Readonly<GarageState>,
  request: Readonly<RegisterVehicleRequest>,
): GarageState {
  const result = registerVehicle(state, VEHICLES, request);
  if (!result.success) {
    throw new Error(result.reason);
  }
  return result.state;
}

function registerEight(cash = 1_000_000): GarageState {
  let state = createGarageState(cash);
  const registerable = VEHICLES.filter((definition) => definition.registerable);
  for (let index = 0; index < GARAGE_SLOT_COUNT; index += 1) {
    const definition = registerable[index % registerable.length];
    if (!definition) throw new Error('Missing registerable test vehicle');
    state = mustRegister(state, {
      instanceId: `owned-${index}`,
      definitionId: definition.id,
    });
  }
  return state;
}

function cloneSnapshot(snapshot: Readonly<GarageSnapshotV1>): GarageSnapshotV1 {
  return JSON.parse(JSON.stringify(snapshot)) as GarageSnapshotV1;
}

describe('vehicle registration and finite ownership', () => {
  it('registers a civilian atomically into the lowest slot with its authored trunk', () => {
    const initial = createGarageState(20_000);
    const request: RegisterVehicleRequest = {
      instanceId: 'alex-sedan',
      definitionId: 'sedan',
      registrationDiscountPercent: 10,
      bodyHealth: 72,
      engineHealth: 61,
      tireHealth: [100, 80, 70, 60],
      paint: 'coastal-teal',
    };
    const result = registerVehicle(initial, VEHICLES, request);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const fee = quoteRegistrationFee(VEHICLES.find(({ id }) => id === 'sedan')!, 10);
    expect(result.cost).toBe(fee);
    expect(result.state.cash).toBe(20_000 - fee);
    expect(result.state.ownedVehicles).toEqual([expect.objectContaining({
      instanceId: 'alex-sedan',
      definitionId: 'sedan',
      registered: true,
      garageSlot: 0,
      bodyHealth: 72,
      engineHealth: 61,
      tireHealth: [100, 80, 70, 60],
      upgrades: { engine: 0, brakes: 0, grip: 0, armor: 0, paint: 'coastal-teal' },
    })]);
    expect(result.state.trunks['alex-sedan']).toEqual({
      gridWidth: 6,
      gridHeight: 4,
      maxWeightKg: 192,
      items: [],
    });
    expect(initial).toEqual(createGarageState(20_000));
  });

  it('retrieves another owned vehicle by atomically swapping the active slot', () => {
    let state = mustRegister(createGarageState(100_000), {
      instanceId: 'starter',
      definitionId: 'compact',
    });
    state = mustRegister(state, {
      instanceId: 'weekend-car',
      definitionId: 'sports',
    });

    const retrieved = retrieveVehicleFromGarage(state, 'weekend-car');
    expect(retrieved.success).toBe(true);
    if (!retrieved.success) return;
    expect(retrieved.cost).toBe(0);
    expect(retrieved.vehicleInstanceId).toBe('weekend-car');
    expect(retrieved.state.ownedVehicles).toEqual([
      expect.objectContaining({ instanceId: 'weekend-car', garageSlot: 0 }),
      expect.objectContaining({ instanceId: 'starter', garageSlot: 1 }),
    ]);
    expect(retrieved.state.trunks).toEqual(state.trunks);

    const alreadyActive = retrieveVehicleFromGarage(retrieved.state, 'weekend-car');
    expect(alreadyActive.success).toBe(false);
    expect(alreadyActive.state).toEqual(retrieved.state);
    expect(retrieveVehicleFromGarage(state, 'missing').success).toBe(false);
  });

  it('rejects duplicate, unknown, police, invalid-condition, and unpaid registrations', () => {
    const owned = mustRegister(createGarageState(20_000), {
      instanceId: 'one',
      definitionId: 'compact',
    });
    const requests: readonly RegisterVehicleRequest[] = [
      { instanceId: 'one', definitionId: 'sedan' },
      { instanceId: 'unknown', definitionId: 'missing' },
      { instanceId: 'police', definitionId: 'police-cruiser' },
      { instanceId: 'bad-health', definitionId: 'compact', engineHealth: -1 },
      { instanceId: 'bad-tire', definitionId: 'compact', tireHealth: [100, 100, 101, 100] },
      { instanceId: 'bad-discount', definitionId: 'compact', registrationDiscountPercent: 101 },
      { instanceId: '__proto__', definitionId: 'compact' },
      { instanceId: 'constructor', definitionId: 'compact' },
    ];
    for (const request of requests) {
      const rejected = registerVehicle(owned, VEHICLES, request);
      expect(rejected.success).toBe(false);
      expect(rejected.state).toEqual(owned);
    }

    const poor = createGarageState(0);
    const unpaid = registerVehicle(poor, VEHICLES, {
      instanceId: 'unpaid',
      definitionId: 'sports',
    });
    expect(unpaid.success).toBe(false);
    expect(unpaid.state).toEqual(poor);
    const compact = VEHICLES.find(({ id }) => id === 'compact')!;
    const free = quoteRegistrationFee(compact, 100);
    expect(free).toBe(0);
    expect(Object.is(free, -0)).toBe(false);
  });

  it('caps ownership at eight and deterministically fills a valid slot gap', () => {
    const full = registerEight();
    expect(full.ownedVehicles.map(({ garageSlot }) => garageSlot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const ninth = registerVehicle(full, VEHICLES, {
      instanceId: 'ninth',
      definitionId: 'sedan',
    });
    expect(ninth.success).toBe(false);
    expect(ninth.state).toEqual(full);

    const withGap: GarageState = {
      ...full,
      ownedVehicles: full.ownedVehicles.filter(({ garageSlot }) => garageSlot !== 3),
      trunks: Object.fromEntries(
        Object.entries(full.trunks).filter(([instanceId]) => instanceId !== 'owned-3'),
      ),
    };
    const replacement = registerVehicle(withGap, VEHICLES, {
      instanceId: 'replacement',
      definitionId: 'sedan',
    });
    expect(replacement.success).toBe(true);
    if (replacement.success) {
      expect(replacement.state.ownedVehicles.find(
        ({ instanceId }) => instanceId === 'replacement',
      )?.garageSlot).toBe(3);
    }
  });
});

describe('garage upgrades, paint, damage, and repair', () => {
  it('requires sequential mechanical tiers and performs immutable cash transactions', () => {
    const registered = mustRegister(createGarageState(100_000), {
      instanceId: 'build-car',
      definitionId: 'muscle',
      bodyHealth: 35,
    });
    const skipped = applyVehicleUpgrade(registered, VEHICLES, {
      instanceId: 'build-car',
      upgrade: 'engine',
      targetTier: 2,
    });
    expect(skipped.success).toBe(false);
    expect(skipped.state).toEqual(registered);

    const tierOne = applyVehicleUpgrade(registered, VEHICLES, {
      instanceId: 'build-car',
      upgrade: 'engine',
      targetTier: 1,
    });
    expect(tierOne.success).toBe(true);
    if (!tierOne.success) return;
    const definition = VEHICLES.find(({ id }) => id === 'muscle')!;
    expect(tierOne.cost).toBe(quoteVehicleUpgrade(definition, 'engine', 1));
    expect(tierOne.state.ownedVehicles[0]?.upgrades.engine).toBe(1);
    expect(tierOne.state.ownedVehicles[0]?.bodyHealth).toBe(35);
    expect(registered.ownedVehicles[0]?.upgrades.engine).toBe(0);

    const repeated = applyVehicleUpgrade(tierOne.state, VEHICLES, {
      instanceId: 'build-car',
      upgrade: 'engine',
      targetTier: 1,
    });
    expect(repeated.success).toBe(false);
    const poor = { ...tierOne.state, cash: 0 };
    const unpaid = applyVehicleUpgrade(poor, VEHICLES, {
      instanceId: 'build-car',
      upgrade: 'engine',
      targetTier: 2,
    });
    expect(unpaid.success).toBe(false);
    expect(unpaid.state).toEqual(poor);
  });

  it('persists authored paint choices and rejects duplicate or unknown paint work', () => {
    const registered = mustRegister(createGarageState(50_000), {
      instanceId: 'paint-car',
      definitionId: 'compact',
    });
    const painted = repaintVehicle(registered, VEHICLES, 'paint-car', 'sunset-orange');
    expect(painted.success).toBe(true);
    if (!painted.success) return;
    expect(painted.state.ownedVehicles[0]?.upgrades.paint).toBe('sunset-orange');
    expect(repaintVehicle(
      painted.state,
      VEHICLES,
      'paint-car',
      'sunset-orange',
    ).success).toBe(false);
    expect(repaintVehicle(
      painted.state,
      VEHICLES,
      'paint-car',
      'unknown' as 'factory',
    ).success).toBe(false);
  });

  it('tracks disabling damage and repairs selected components without partial charges', () => {
    const registered = mustRegister(createGarageState(30_000), {
      instanceId: 'repair-car',
      definitionId: 'sedan',
      bodyHealth: 40,
      engineHealth: 30,
      tireHealth: [100, 50, 25, 0],
    });
    const damaged = applyVehicleDamage(registered, {
      instanceId: 'repair-car',
      engineDamage: 50,
      bodyDamage: 10,
      tireDamage: [0, 10, 100, 0],
    });
    expect(damaged.success).toBe(true);
    if (!damaged.success) return;
    const vehicle = damaged.state.ownedVehicles[0]!;
    expect(vehicle).toEqual(expect.objectContaining({
      bodyHealth: 30,
      engineHealth: 0,
      tireHealth: [100, 40, 0, 0],
    }));
    expect(vehicleOperatingState(vehicle)).toBe('engine-disabled');
    expect(applyVehicleDamage(damaged.state, {
      instanceId: 'repair-car',
      engineDamage: -1,
    }).success).toBe(false);

    const definition = VEHICLES.find(({ id }) => id === 'sedan')!;
    const engineCost = quoteVehicleRepair(vehicle, definition, 'engine');
    const poor = { ...damaged.state, cash: engineCost - 1 };
    const unpaid = repairVehicle(poor, VEHICLES, {
      instanceId: 'repair-car',
      scope: 'engine',
    });
    expect(unpaid.success).toBe(false);
    expect(unpaid.state).toEqual(poor);

    const repairedEngine = repairVehicle(damaged.state, VEHICLES, {
      instanceId: 'repair-car',
      scope: 'engine',
    });
    expect(repairedEngine.success).toBe(true);
    if (!repairedEngine.success) return;
    expect(repairedEngine.cost).toBe(engineCost);
    expect(repairedEngine.state.ownedVehicles[0]).toEqual(expect.objectContaining({
      bodyHealth: 30,
      engineHealth: 100,
      tireHealth: [100, 40, 0, 0],
    }));
    expect(vehicleOperatingState(repairedEngine.state.ownedVehicles[0]!)).toBe('operational');

    const fullyRepaired = repairVehicle(repairedEngine.state, VEHICLES, {
      instanceId: 'repair-car',
      scope: 'all',
    });
    expect(fullyRepaired.success).toBe(true);
    if (!fullyRepaired.success) return;
    expect(fullyRepaired.state.ownedVehicles[0]).toEqual(expect.objectContaining({
      bodyHealth: 100,
      engineHealth: 100,
      tireHealth: [100, 100, 100, 100],
    }));
    const noOp = repairVehicle(fullyRepaired.state, VEHICLES, {
      instanceId: 'repair-car',
      scope: 'all',
    });
    expect(noOp.success).toBe(false);
    expect(noOp.state).toEqual(fullyRepaired.state);
  });
});

describe('bounded trunk inventory', () => {
  it('uses class-specific dimensions, rejects overflow/weight, and expands one row once', () => {
    const sportsDefinition = VEHICLES.find(({ id }) => id === 'sports')!;
    expect(trunkCapacityFor(sportsDefinition, 0)).toEqual({
      gridWidth: 3,
      gridHeight: 2,
      maxWeightKg: 48,
    });
    let state = mustRegister(createGarageState(100_000), {
      instanceId: 'sports-trunk',
      definitionId: 'sports',
    });
    const filled = storeItemInTrunk(state, TRUNK_ITEMS, 'sports-trunk', {
      definitionId: 'cargo-box',
      quantity: 6,
      instanceIdBase: 'box',
    });
    expect(filled.success).toBe(true);
    if (!filled.success) return;
    state = filled.state;
    expect(state.trunks['sports-trunk']?.items).toHaveLength(6);
    const overflow = storeItemInTrunk(state, TRUNK_ITEMS, 'sports-trunk', {
      definitionId: 'cargo-box',
      quantity: 1,
      instanceIdBase: 'overflow',
    });
    expect(overflow.success).toBe(false);
    expect(overflow.state).toEqual(state);

    const expanded = unlockTrunkRowBonus(state, VEHICLES);
    expect(expanded.success).toBe(true);
    if (!expanded.success) return;
    expect(expanded.state.trunks['sports-trunk']).toEqual(expect.objectContaining({
      gridWidth: 3,
      gridHeight: 3,
      maxWeightKg: 72,
    }));
    expect(expanded.state.trunks['sports-trunk']?.items).toEqual(
      state.trunks['sports-trunk']?.items,
    );
    expect(unlockTrunkRowBonus(expanded.state, VEHICLES).success).toBe(false);

    const future = mustRegister(expanded.state, {
      instanceId: 'future-bike',
      definitionId: 'motorcycle',
    });
    expect(future.trunks['future-bike']).toEqual(expect.objectContaining({
      gridWidth: 2,
      gridHeight: 3,
      maxWeightKg: 48,
    }));
    const overweight = storeItemInTrunk(future, TRUNK_ITEMS, 'future-bike', {
      definitionId: 'heavy-part',
      quantity: 2,
      instanceIdBase: 'heavy',
    });
    expect(overweight.success).toBe(false);
    expect(overweight.state).toEqual(future);
  });

  it('validates replacement dimensions and item ids across every owned trunk', () => {
    let state = mustRegister(createGarageState(50_000), {
      instanceId: 'first',
      definitionId: 'compact',
    });
    state = mustRegister(state, {
      instanceId: 'second',
      definitionId: 'compact',
    });
    const wrongSize: SavedInventory = {
      gridWidth: 99,
      gridHeight: 3,
      maxWeightKg: 96,
      items: [],
    };
    const invalid = replaceVehicleTrunk(
      state,
      VEHICLES,
      TRUNK_ITEMS,
      'first',
      wrongSize,
    );
    expect(invalid.success).toBe(false);
    expect(invalid.state).toEqual(state);

    const firstItem = storeItemInTrunk(state, TRUNK_ITEMS, 'first', {
      definitionId: 'cargo-box',
      quantity: 1,
      instanceIdBase: 'shared-id',
    });
    expect(firstItem.success).toBe(true);
    if (!firstItem.success) return;
    const duplicateTrunk: SavedInventory = {
      ...firstItem.state.trunks.second!,
      items: [{
        instanceId: 'shared-id',
        definitionId: 'cargo-box',
        quantity: 1,
        durability: 100,
        x: 0,
        y: 0,
        rotated: false,
      }],
    };
    const duplicate = replaceVehicleTrunk(
      firstItem.state,
      VEHICLES,
      TRUNK_ITEMS,
      'second',
      duplicateTrunk,
    );
    expect(duplicate.success).toBe(false);
    expect(duplicate.state).toEqual(firstItem.state);
  });
});

describe('garage snapshot and restore validation', () => {
  it('round-trips upgraded, damaged, cargo-bearing vehicles deterministically without aliases', () => {
    let state = mustRegister(createGarageState(100_000), {
      instanceId: 'z-sedan',
      definitionId: 'sedan',
      engineHealth: 70,
    });
    state = mustRegister(state, {
      instanceId: 'a-compact',
      definitionId: 'compact',
    });
    const upgraded = applyVehicleUpgrade(state, VEHICLES, {
      instanceId: 'z-sedan',
      upgrade: 'grip',
      targetTier: 1,
    });
    if (!upgraded.success) throw new Error(upgraded.reason);
    const stored = storeItemInTrunk(upgraded.state, TRUNK_ITEMS, 'z-sedan', {
      definitionId: 'cargo-box',
      quantity: 2,
      instanceIdBase: 'cargo',
    });
    if (!stored.success) throw new Error(stored.reason);
    const expanded = unlockTrunkRowBonus(stored.state, VEHICLES);
    if (!expanded.success) throw new Error(expanded.reason);

    const deliberatelyUnsorted: GarageState = {
      ...expanded.state,
      ownedVehicles: [...expanded.state.ownedVehicles].reverse(),
    };
    const snapshot = snapshotGarageState(deliberatelyUnsorted);
    expect(snapshot.ownedVehicles.map(({ garageSlot }) => garageSlot)).toEqual([0, 1]);
    expect(Object.keys(snapshot.trunks)).toEqual(['a-compact', 'z-sedan']);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(validateGarageSnapshot(snapshot, VEHICLES, TRUNK_ITEMS)).toEqual({
      valid: true,
      errors: [],
    });

    const restored = restoreGarageSnapshot(snapshot, VEHICLES, TRUNK_ITEMS);
    expect(restored.success).toBe(true);
    if (!restored.success) return;
    expect(snapshotGarageState(restored.state)).toEqual(snapshot);
    snapshot.ownedVehicles[0]!.engineHealth = 0;
    snapshot.trunks['z-sedan']!.items[0]!.quantity = 99;
    expect(restored.state.ownedVehicles[0]?.engineHealth).toBe(70);
    expect(restored.state.trunks['z-sedan']?.items[0]?.quantity).toBe(1);
  });

  it('rejects corrupt slots, definitions, health, tiers, ownership links, and inventory layouts', () => {
    const state = mustRegister(createGarageState(50_000), {
      instanceId: 'validated',
      definitionId: 'compact',
    });
    const base = snapshotGarageState(state);
    const corruptions: readonly [string, (snapshot: GarageSnapshotV1) => void][] = [
      ['schemaVersion', (snapshot) => { (snapshot as { schemaVersion: number }).schemaVersion = 2; }],
      ['garageSlot', (snapshot) => { snapshot.ownedVehicles[0]!.garageSlot = 8; }],
      ['unknown vehicle', (snapshot) => { snapshot.ownedVehicles[0]!.definitionId = 'missing'; }],
      ['non-registerable', (snapshot) => { snapshot.ownedVehicles[0]!.definitionId = 'police-cruiser'; }],
      ['health', (snapshot) => { snapshot.ownedVehicles[0]!.engineHealth = Number.NaN; }],
      ['between 0 and 3', (snapshot) => { snapshot.ownedVehicles[0]!.upgrades.engine = 4; }],
      ['required', (snapshot) => { delete snapshot.trunks.validated; }],
      ['does not belong', (snapshot) => {
        snapshot.trunks.orphan = { gridWidth: 1, gridHeight: 1, maxWeightKg: 8, items: [] };
      }],
      ['gridWidth', (snapshot) => { snapshot.trunks.validated!.gridWidth = 5; }],
      ['unknown definition', (snapshot) => {
        snapshot.trunks.validated!.items.push({
          instanceId: 'unknown-item',
          definitionId: 'missing-item',
          quantity: 1,
          durability: 100,
          x: 0,
          y: 0,
          rotated: false,
        });
      }],
    ];

    for (const [expected, corrupt] of corruptions) {
      const snapshot = cloneSnapshot(base);
      corrupt(snapshot);
      const result = restoreGarageSnapshot(snapshot, VEHICLES, TRUNK_ITEMS);
      expect(result.success, expected).toBe(false);
      if (!result.success) {
        expect(result.errors.join(' '), expected).toContain(expected);
      }
    }

    const duplicateSlot = cloneSnapshot(base);
    duplicateSlot.ownedVehicles.push({
      ...duplicateSlot.ownedVehicles[0]!,
      instanceId: 'duplicate-slot',
    });
    duplicateSlot.trunks['duplicate-slot'] = cloneSnapshot(base).trunks.validated!;
    const duplicateResult = restoreGarageSnapshot(
      duplicateSlot,
      VEHICLES,
      TRUNK_ITEMS,
    );
    expect(duplicateResult.success).toBe(false);
    if (!duplicateResult.success) {
      expect(duplicateResult.errors.join(' ')).toContain('garageSlot must be unique');
    }

    const inheritedKey = cloneSnapshot(base);
    inheritedKey.ownedVehicles[0]!.instanceId = 'constructor';
    delete inheritedKey.trunks.validated;
    const inheritedResult = restoreGarageSnapshot(
      inheritedKey,
      VEHICLES,
      TRUNK_ITEMS,
    );
    expect(inheritedResult.success).toBe(false);
    if (!inheritedResult.success) {
      expect(inheritedResult.errors.join(' ')).toContain('safe non-reserved identifier');
      expect(inheritedResult.errors.join(' ')).toContain('trunks.constructor is required');
    }
  });

  it('rejects more than eight otherwise bounded ownership records', () => {
    const full = snapshotGarageState(registerEight());
    const ninth = cloneSnapshot(full);
    ninth.ownedVehicles.push({
      ...ninth.ownedVehicles[0]!,
      instanceId: 'overflow',
      garageSlot: 8,
    });
    ninth.trunks.overflow = cloneSnapshot(full).trunks['owned-0']!;
    const validation = validateGarageSnapshot(ninth, VEHICLES, TRUNK_ITEMS);
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.errors.join(' ')).toContain('cannot exceed 8');
    }
  });
});
