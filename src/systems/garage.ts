import type {
  SavedInventory,
  SavedItemInstance,
  SavedVehicle,
} from '../core/state';
import type { ItemDefinition, VehicleDefinition } from '../data/types';
import {
  addItem,
  createInventory,
  validateInventory,
} from './inventory';
import type { AddItemRequest } from './inventory';

export const GARAGE_SNAPSHOT_VERSION = 1 as const;
export const GARAGE_SLOT_COUNT = 8 as const;
export const TRUNK_WEIGHT_KG_PER_CELL = 8 as const;

export const GARAGE_PAINTS = [
  'factory',
  'coastal-teal',
  'sunset-orange',
  'midnight-indigo',
] as const;

export type GaragePaint = (typeof GARAGE_PAINTS)[number];
export type VehicleUpgradeKind = 'engine' | 'brakes' | 'grip' | 'armor';
export type VehicleUpgradeTier = 1 | 2 | 3;
export type VehicleRepairScope = 'body' | 'engine' | 'tires' | 'all';
export type VehicleOperatingState = 'operational' | 'engine-disabled';
export type TrunkRowBonus = 0 | 1;

export interface GarageState {
  cash: number;
  trunkRowBonus: TrunkRowBonus;
  /** Optional property perk applied to service quotes and committed repairs. */
  vehicleRepairDiscountPercent?: number;
  ownedVehicles: SavedVehicle[];
  trunks: Record<string, SavedInventory>;
}

export interface GarageSnapshotV1 extends GarageState {
  schemaVersion: typeof GARAGE_SNAPSHOT_VERSION;
}

export interface RegisterVehicleRequest {
  instanceId: string;
  definitionId: string;
  registrationDiscountPercent?: number;
  bodyHealth?: number;
  engineHealth?: number;
  tireHealth?: readonly [number, number, number, number];
  paint?: GaragePaint;
}

export interface VehicleUpgradeRequest {
  instanceId: string;
  upgrade: VehicleUpgradeKind;
  targetTier: VehicleUpgradeTier;
}

export interface VehicleDamageRequest {
  instanceId: string;
  bodyDamage?: number;
  engineDamage?: number;
  tireDamage?: readonly [number, number, number, number];
}

export interface VehicleRepairRequest {
  instanceId: string;
  scope: VehicleRepairScope;
}

export type GarageTransactionResult =
  | {
    success: true;
    state: GarageState;
    cost: number;
    vehicleInstanceId: string | null;
  }
  | {
    success: false;
    state: GarageState;
    reason: string;
  };

export type GarageValidationResult =
  | { valid: true; errors: readonly [] }
  | { valid: false; errors: readonly string[] };

export type GarageRestoreResult =
  | { success: true; state: GarageState }
  | { success: false; errors: readonly string[] };

const REGISTRATION_VALUE_RATE = 0.1;
const PAINT_VALUE_RATE = 0.03;
const VEHICLE_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const UPGRADE_TIER_VALUE_RATE: Readonly<Record<VehicleUpgradeTier, number>> = {
  1: 0.06,
  2: 0.1,
  3: 0.16,
};

const UPGRADE_KIND_MULTIPLIER: Readonly<Record<VehicleUpgradeKind, number>> = {
  engine: 1.15,
  brakes: 0.85,
  grip: 1,
  armor: 1.25,
};

const REPAIR_VALUE_RATE = {
  body: 0.12,
  engine: 0.16,
  tire: 0.02,
} as const;

export function createGarageState(
  cash = 0,
  trunkRowBonus: TrunkRowBonus = 0,
): GarageState {
  if (!isNonNegativeSafeInteger(cash)) {
    throw new RangeError('garage cash must be a non-negative safe integer');
  }
  assertTrunkRowBonus(trunkRowBonus);
  return {
    cash,
    trunkRowBonus,
    ownedVehicles: [],
    trunks: {},
  };
}

export function trunkCapacityFor(
  definition: Readonly<VehicleDefinition>,
  rowBonus: TrunkRowBonus,
): Pick<SavedInventory, 'gridWidth' | 'gridHeight' | 'maxWeightKg'> {
  assertTrunkRowBonus(rowBonus);
  const gridWidth = definition.cargoGrid.columns;
  const gridHeight = definition.cargoGrid.rows + rowBonus;
  return {
    gridWidth,
    gridHeight,
    maxWeightKg: gridWidth * gridHeight * TRUNK_WEIGHT_KG_PER_CELL,
  };
}

export function createVehicleTrunk(
  definition: Readonly<VehicleDefinition>,
  rowBonus: TrunkRowBonus,
): SavedInventory {
  const capacity = trunkCapacityFor(definition, rowBonus);
  return createInventory(
    capacity.gridWidth,
    capacity.gridHeight,
    capacity.maxWeightKg,
  );
}

export function quoteRegistrationFee(
  definition: Readonly<VehicleDefinition>,
  discountPercent = 0,
): number {
  assertPercent(discountPercent, 'registration discount');
  return Math.max(
    0,
    Math.ceil(
      definition.baseValue
      * REGISTRATION_VALUE_RATE
      * (1 - discountPercent / 100)
      - Number.EPSILON,
    ),
  );
}

export function registerVehicle(
  state: Readonly<GarageState>,
  definitions: readonly VehicleDefinition[],
  request: Readonly<RegisterVehicleRequest>,
): GarageTransactionResult {
  const original = cloneGarageState(state);
  const instanceId = request.instanceId.trim();
  if (!isSafeVehicleInstanceId(instanceId)) {
    return failure(original, 'vehicle instance id must use a safe non-reserved identifier');
  }
  if (state.ownedVehicles.some((vehicle) => vehicle.instanceId === instanceId)) {
    return failure(original, `vehicle instance "${instanceId}" is already owned`);
  }

  const definition = vehicleCatalog(definitions).get(request.definitionId);
  if (!definition) {
    return failure(original, `unknown vehicle definition "${request.definitionId}"`);
  }
  if (!definition.registerable) {
    return failure(original, `${definition.id} cannot be registered`);
  }

  const slot = firstFreeGarageSlot(state.ownedVehicles);
  if (slot === null) {
    return failure(original, `garage has no free slots (maximum ${GARAGE_SLOT_COUNT})`);
  }

  const discount = request.registrationDiscountPercent ?? 0;
  if (!isPercent(discount)) {
    return failure(original, 'registration discount must be between 0 and 100');
  }
  const bodyHealth = request.bodyHealth ?? 100;
  const engineHealth = request.engineHealth ?? 100;
  const tireHealth = request.tireHealth ?? [100, 100, 100, 100];
  if (!isHealth(bodyHealth) || !isHealth(engineHealth)) {
    return failure(original, 'vehicle body and engine health must be between 0 and 100');
  }
  if (tireHealth.length !== 4 || tireHealth.some((health) => !isHealth(health))) {
    return failure(original, 'vehicle tire health must contain four values between 0 and 100');
  }
  const paint = request.paint ?? 'factory';
  if (!isGaragePaint(paint)) {
    return failure(original, `unknown garage paint "${paint}"`);
  }

  const cost = quoteRegistrationFee(definition, discount);
  if (state.cash < cost) {
    return failure(original, `registration requires ${cost} cash`);
  }

  const vehicle: SavedVehicle = {
    instanceId,
    definitionId: definition.id,
    registered: true,
    garageSlot: slot,
    bodyHealth,
    engineHealth,
    tireHealth: [...tireHealth],
    upgrades: {
      engine: 0,
      brakes: 0,
      grip: 0,
      armor: 0,
      paint,
    },
  };
  const next = cloneGarageState(state);
  next.cash -= cost;
  next.ownedVehicles.push(vehicle);
  next.ownedVehicles.sort(compareVehicles);
  next.trunks[instanceId] = createVehicleTrunk(definition, state.trunkRowBonus);
  return success(next, cost, instanceId);
}

export function quoteVehicleUpgrade(
  definition: Readonly<VehicleDefinition>,
  upgrade: VehicleUpgradeKind,
  targetTier: VehicleUpgradeTier,
): number {
  const rate = UPGRADE_TIER_VALUE_RATE[targetTier];
  const multiplier = UPGRADE_KIND_MULTIPLIER[upgrade];
  if (rate === undefined || multiplier === undefined) {
    throw new RangeError('vehicle upgrade and tier must be valid');
  }
  return Math.max(
    1,
    Math.ceil(definition.baseValue * rate * multiplier - Number.EPSILON),
  );
}

export function applyVehicleUpgrade(
  state: Readonly<GarageState>,
  definitions: readonly VehicleDefinition[],
  request: Readonly<VehicleUpgradeRequest>,
): GarageTransactionResult {
  const original = cloneGarageState(state);
  const vehicle = state.ownedVehicles.find(
    (candidate) => candidate.instanceId === request.instanceId,
  );
  if (!vehicle?.registered) {
    return failure(original, `registered vehicle "${request.instanceId}" was not found`);
  }
  if (!isUpgradeKind(request.upgrade) || !isUpgradeTier(request.targetTier)) {
    return failure(original, 'upgrade kind and target tier must be valid');
  }

  const currentTier = vehicle.upgrades[request.upgrade];
  if (currentTier >= 3) {
    return failure(original, `${request.upgrade} is already at maximum tier`);
  }
  if (request.targetTier !== currentTier + 1) {
    return failure(original, `${request.upgrade} upgrades must be applied one tier at a time`);
  }

  const definition = vehicleCatalog(definitions).get(vehicle.definitionId);
  if (!definition) {
    return failure(original, `unknown vehicle definition "${vehicle.definitionId}"`);
  }
  const cost = quoteVehicleUpgrade(definition, request.upgrade, request.targetTier);
  if (state.cash < cost) {
    return failure(original, `${request.upgrade} tier ${request.targetTier} requires ${cost} cash`);
  }

  const next = cloneGarageState(state);
  const upgraded = findOwnedVehicle(next, request.instanceId);
  if (!upgraded) {
    return failure(original, `vehicle "${request.instanceId}" was not found`);
  }
  upgraded.upgrades[request.upgrade] = request.targetTier;
  next.cash -= cost;
  return success(next, cost, request.instanceId);
}

export function quoteVehiclePaint(
  definition: Readonly<VehicleDefinition>,
): number {
  return Math.max(
    1,
    Math.ceil(definition.baseValue * PAINT_VALUE_RATE - Number.EPSILON),
  );
}

export function repaintVehicle(
  state: Readonly<GarageState>,
  definitions: readonly VehicleDefinition[],
  instanceId: string,
  paint: GaragePaint,
): GarageTransactionResult {
  const original = cloneGarageState(state);
  const vehicle = state.ownedVehicles.find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!vehicle?.registered) {
    return failure(original, `registered vehicle "${instanceId}" was not found`);
  }
  if (!isGaragePaint(paint)) {
    return failure(original, `unknown garage paint "${paint}"`);
  }
  if (vehicle.upgrades.paint === paint) {
    return failure(original, `vehicle already uses ${paint} paint`);
  }
  const definition = vehicleCatalog(definitions).get(vehicle.definitionId);
  if (!definition) {
    return failure(original, `unknown vehicle definition "${vehicle.definitionId}"`);
  }
  const cost = quoteVehiclePaint(definition);
  if (state.cash < cost) {
    return failure(original, `paint service requires ${cost} cash`);
  }
  const next = cloneGarageState(state);
  const repainted = findOwnedVehicle(next, instanceId);
  if (!repainted) {
    return failure(original, `vehicle "${instanceId}" was not found`);
  }
  repainted.upgrades.paint = paint;
  next.cash -= cost;
  return success(next, cost, instanceId);
}

/**
 * Makes an owned vehicle the garage's active retrieval slot. The previous
 * slot-zero vehicle is swapped into the selected slot so all eight slots stay
 * unique and save-compatible without introducing a parallel active-id field.
 */
export function retrieveVehicleFromGarage(
  state: Readonly<GarageState>,
  instanceId: string,
): GarageTransactionResult {
  const original = cloneGarageState(state);
  const vehicle = state.ownedVehicles.find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!vehicle?.registered) {
    return failure(original, `registered vehicle "${instanceId}" was not found`);
  }
  if (vehicle.garageSlot === 0) {
    return failure(original, `vehicle "${instanceId}" is already active`);
  }
  const next = cloneGarageState(state);
  const selected = findOwnedVehicle(next, instanceId);
  if (!selected) {
    return failure(original, `vehicle "${instanceId}" was not found`);
  }
  const selectedSlot = selected.garageSlot;
  const previousActive = next.ownedVehicles.find(
    (candidate) => candidate.garageSlot === 0,
  );
  if (previousActive) previousActive.garageSlot = selectedSlot;
  selected.garageSlot = 0;
  next.ownedVehicles.sort(compareVehicles);
  return success(next, 0, instanceId);
}

export function applyVehicleDamage(
  state: Readonly<GarageState>,
  request: Readonly<VehicleDamageRequest>,
): GarageTransactionResult {
  const original = cloneGarageState(state);
  const vehicle = state.ownedVehicles.find(
    (candidate) => candidate.instanceId === request.instanceId,
  );
  if (!vehicle) {
    return failure(original, `owned vehicle "${request.instanceId}" was not found`);
  }
  const bodyDamage = request.bodyDamage ?? 0;
  const engineDamage = request.engineDamage ?? 0;
  const tireDamage = request.tireDamage ?? [0, 0, 0, 0];
  if (
    !isDamage(bodyDamage)
    || !isDamage(engineDamage)
    || tireDamage.length !== 4
    || tireDamage.some((damage) => !isDamage(damage))
  ) {
    return failure(original, 'vehicle damage must use finite non-negative values');
  }
  if (bodyDamage === 0 && engineDamage === 0 && tireDamage.every((damage) => damage === 0)) {
    return failure(original, 'vehicle damage request does not change any component');
  }

  const next = cloneGarageState(state);
  const damaged = findOwnedVehicle(next, request.instanceId);
  if (!damaged) {
    return failure(original, `vehicle "${request.instanceId}" was not found`);
  }
  damaged.bodyHealth = Math.max(0, damaged.bodyHealth - bodyDamage);
  damaged.engineHealth = Math.max(0, damaged.engineHealth - engineDamage);
  damaged.tireHealth = damaged.tireHealth.map(
    (health, index) => Math.max(0, health - (tireDamage[index] ?? 0)),
  ) as [number, number, number, number];
  if (sameVehicleCondition(vehicle, damaged)) {
    return failure(original, 'vehicle components are already fully damaged');
  }
  return success(next, 0, request.instanceId);
}

export function vehicleOperatingState(
  vehicle: Readonly<SavedVehicle>,
): VehicleOperatingState {
  return vehicle.engineHealth <= 0 ? 'engine-disabled' : 'operational';
}

export function quoteVehicleRepair(
  vehicle: Readonly<SavedVehicle>,
  definition: Readonly<VehicleDefinition>,
  scope: VehicleRepairScope,
  discountPercent = 0,
): number {
  if (!isRepairScope(scope)) {
    throw new RangeError('vehicle repair scope must be valid');
  }
  const bodyMissing = scope === 'body' || scope === 'all'
    ? 100 - vehicle.bodyHealth
    : 0;
  const engineMissing = scope === 'engine' || scope === 'all'
    ? 100 - vehicle.engineHealth
    : 0;
  const tireMissing = scope === 'tires' || scope === 'all'
    ? vehicle.tireHealth.reduce((total, health) => total + 100 - health, 0)
    : 0;
  const rawCost = definition.baseValue * (
    REPAIR_VALUE_RATE.body * bodyMissing / 100
    + REPAIR_VALUE_RATE.engine * engineMissing / 100
    + REPAIR_VALUE_RATE.tire * tireMissing / 100
  );
  assertPercent(discountPercent, 'vehicle repair discount');
  const discountedCost = rawCost * (1 - discountPercent / 100);
  return discountedCost > 0 ? Math.max(1, Math.ceil(discountedCost - Number.EPSILON)) : 0;
}

export function repairVehicle(
  state: Readonly<GarageState>,
  definitions: readonly VehicleDefinition[],
  request: Readonly<VehicleRepairRequest>,
): GarageTransactionResult {
  const original = cloneGarageState(state);
  const vehicle = state.ownedVehicles.find(
    (candidate) => candidate.instanceId === request.instanceId,
  );
  if (!vehicle?.registered) {
    return failure(original, `registered vehicle "${request.instanceId}" was not found`);
  }
  if (!isRepairScope(request.scope)) {
    return failure(original, 'vehicle repair scope must be valid');
  }
  const definition = vehicleCatalog(definitions).get(vehicle.definitionId);
  if (!definition) {
    return failure(original, `unknown vehicle definition "${vehicle.definitionId}"`);
  }
  const cost = quoteVehicleRepair(
    vehicle,
    definition,
    request.scope,
    state.vehicleRepairDiscountPercent ?? 0,
  );
  if (cost === 0) {
    return failure(original, `vehicle has no ${request.scope} damage to repair`);
  }
  if (state.cash < cost) {
    return failure(original, `${request.scope} repair requires ${cost} cash`);
  }

  const next = cloneGarageState(state);
  const repaired = findOwnedVehicle(next, request.instanceId);
  if (!repaired) {
    return failure(original, `vehicle "${request.instanceId}" was not found`);
  }
  if (request.scope === 'body' || request.scope === 'all') {
    repaired.bodyHealth = 100;
  }
  if (request.scope === 'engine' || request.scope === 'all') {
    repaired.engineHealth = 100;
  }
  if (request.scope === 'tires' || request.scope === 'all') {
    repaired.tireHealth = [100, 100, 100, 100];
  }
  next.cash -= cost;
  return success(next, cost, request.instanceId);
}

export function unlockTrunkRowBonus(
  state: Readonly<GarageState>,
  definitions: readonly VehicleDefinition[],
): GarageTransactionResult {
  const original = cloneGarageState(state);
  if (state.trunkRowBonus === 1) {
    return failure(original, 'trunk row bonus is already unlocked');
  }
  const catalog = vehicleCatalog(definitions);
  const next = cloneGarageState(state);
  next.trunkRowBonus = 1;
  for (const vehicle of next.ownedVehicles) {
    const definition = catalog.get(vehicle.definitionId);
    const trunk = next.trunks[vehicle.instanceId];
    if (!definition || !trunk) {
      return failure(original, `vehicle "${vehicle.instanceId}" cannot expand its trunk`);
    }
    const capacity = trunkCapacityFor(definition, 1);
    trunk.gridWidth = capacity.gridWidth;
    trunk.gridHeight = capacity.gridHeight;
    trunk.maxWeightKg = capacity.maxWeightKg;
  }
  return success(next, 0, null);
}

export function storeItemInTrunk(
  state: Readonly<GarageState>,
  itemDefinitions: readonly ItemDefinition[],
  vehicleInstanceId: string,
  request: Readonly<AddItemRequest>,
): GarageTransactionResult {
  const original = cloneGarageState(state);
  if (!state.ownedVehicles.some((vehicle) => vehicle.instanceId === vehicleInstanceId)) {
    return failure(original, `owned vehicle "${vehicleInstanceId}" was not found`);
  }
  const trunk = state.trunks[vehicleInstanceId];
  if (!trunk) {
    return failure(original, `vehicle "${vehicleInstanceId}" has no trunk inventory`);
  }
  const added = addItem(trunk, itemDefinitions, request);
  if (!added.success) {
    return failure(original, added.reason);
  }
  const next = cloneGarageState(state);
  next.trunks[vehicleInstanceId] = added.inventory;
  const duplicate = duplicateTrunkItemInstanceId(next.trunks);
  if (duplicate) {
    return failure(original, `trunk item instance "${duplicate}" is duplicated`);
  }
  return success(next, 0, vehicleInstanceId);
}

export function replaceVehicleTrunk(
  state: Readonly<GarageState>,
  vehicleDefinitions: readonly VehicleDefinition[],
  itemDefinitions: readonly ItemDefinition[],
  vehicleInstanceId: string,
  trunk: Readonly<SavedInventory>,
): GarageTransactionResult {
  const original = cloneGarageState(state);
  const vehicle = state.ownedVehicles.find(
    (candidate) => candidate.instanceId === vehicleInstanceId,
  );
  if (!vehicle) {
    return failure(original, `owned vehicle "${vehicleInstanceId}" was not found`);
  }
  const definition = vehicleCatalog(vehicleDefinitions).get(vehicle.definitionId);
  if (!definition) {
    return failure(original, `unknown vehicle definition "${vehicle.definitionId}"`);
  }
  const errors = validateTrunk(
    trunk,
    definition,
    state.trunkRowBonus,
    itemDefinitions,
    `trunks.${vehicleInstanceId}`,
  );
  if (errors.length > 0) {
    return failure(original, errors.join('; '));
  }
  const next = cloneGarageState(state);
  next.trunks[vehicleInstanceId] = cloneInventory(trunk);
  const duplicate = duplicateTrunkItemInstanceId(next.trunks);
  if (duplicate) {
    return failure(original, `trunk item instance "${duplicate}" is duplicated`);
  }
  return success(next, 0, vehicleInstanceId);
}

export function snapshotGarageState(
  state: Readonly<GarageState>,
): GarageSnapshotV1 {
  const cloned = cloneGarageState(state);
  return {
    schemaVersion: GARAGE_SNAPSHOT_VERSION,
    cash: cloned.cash,
    trunkRowBonus: cloned.trunkRowBonus,
    ownedVehicles: cloned.ownedVehicles,
    trunks: cloned.trunks,
  };
}

export function validateGarageSnapshot(
  value: unknown,
  vehicleDefinitions: readonly VehicleDefinition[],
  itemDefinitions: readonly ItemDefinition[],
): GarageValidationResult {
  const errors = garageSnapshotErrors(value, vehicleDefinitions, itemDefinitions);
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

export function restoreGarageSnapshot(
  value: unknown,
  vehicleDefinitions: readonly VehicleDefinition[],
  itemDefinitions: readonly ItemDefinition[],
): GarageRestoreResult {
  const validation = validateGarageSnapshot(value, vehicleDefinitions, itemDefinitions);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }
  const snapshot = value as GarageSnapshotV1;
  return {
    success: true,
    state: cloneGarageState(snapshot),
  };
}

function garageSnapshotErrors(
  value: unknown,
  vehicleDefinitions: readonly VehicleDefinition[],
  itemDefinitions: readonly ItemDefinition[],
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ['garage snapshot must be an object'];
  }
  if (value.schemaVersion !== GARAGE_SNAPSHOT_VERSION) {
    errors.push(`schemaVersion must be ${GARAGE_SNAPSHOT_VERSION}`);
  }
  if (!isNonNegativeSafeInteger(value.cash)) {
    errors.push('cash must be a non-negative safe integer');
  }
  if (!isTrunkRowBonus(value.trunkRowBonus)) {
    errors.push('trunkRowBonus must be 0 or 1');
  }
  if (!Array.isArray(value.ownedVehicles)) {
    errors.push('ownedVehicles must be an array');
  }
  if (!isRecord(value.trunks)) {
    errors.push('trunks must be an object');
  }
  if (
    !Array.isArray(value.ownedVehicles)
    || !isRecord(value.trunks)
    || !isTrunkRowBonus(value.trunkRowBonus)
  ) {
    return errors;
  }
  if (value.ownedVehicles.length > GARAGE_SLOT_COUNT) {
    errors.push(`ownedVehicles cannot exceed ${GARAGE_SLOT_COUNT} garage slots`);
  }

  const vehicleDefinitionsById = vehicleCatalog(vehicleDefinitions);
  const instanceIds = new Set<string>();
  const slots = new Set<number>();
  const vehicleDefinitionByInstance = new Map<string, VehicleDefinition>();
  value.ownedVehicles.forEach((entry, index) => {
    const path = `ownedVehicles[${index}]`;
    if (!isSavedVehicleShape(entry)) {
      errors.push(`${path} is malformed`);
      return;
    }
    if (!isSafeVehicleInstanceId(entry.instanceId)) {
      errors.push(`${path}.instanceId must use a safe non-reserved identifier`);
    } else if (instanceIds.has(entry.instanceId)) {
      errors.push(`${path}.instanceId must be unique`);
    }
    instanceIds.add(entry.instanceId);
    if (!entry.registered) {
      errors.push(`${path} must be registered before it can be owned`);
    }
    if (!Number.isSafeInteger(entry.garageSlot) || entry.garageSlot < 0 || entry.garageSlot >= GARAGE_SLOT_COUNT) {
      errors.push(`${path}.garageSlot must be between 0 and ${GARAGE_SLOT_COUNT - 1}`);
    } else if (slots.has(entry.garageSlot)) {
      errors.push(`${path}.garageSlot must be unique`);
    }
    slots.add(entry.garageSlot);

    const definition = vehicleDefinitionsById.get(entry.definitionId);
    if (!definition) {
      errors.push(`${path} uses unknown vehicle definition "${entry.definitionId}"`);
    } else if (!definition.registerable) {
      errors.push(`${path} uses non-registerable vehicle definition "${entry.definitionId}"`);
    } else {
      vehicleDefinitionByInstance.set(entry.instanceId, definition);
    }
    if (!isHealth(entry.bodyHealth) || !isHealth(entry.engineHealth)) {
      errors.push(`${path} body and engine health must be between 0 and 100`);
    }
    if (entry.tireHealth.some((health) => !isHealth(health))) {
      errors.push(`${path}.tireHealth values must be between 0 and 100`);
    }
    for (const kind of ['engine', 'brakes', 'grip', 'armor'] as const) {
      const tier = entry.upgrades[kind];
      if (!Number.isSafeInteger(tier) || tier < 0 || tier > 3) {
        errors.push(`${path}.upgrades.${kind} must be between 0 and 3`);
      }
    }
    if (!isGaragePaint(entry.upgrades.paint)) {
      errors.push(`${path}.upgrades.paint is not an authored garage paint`);
    }
  });

  const globalItemIds = new Set<string>();
  for (const [vehicleInstanceId, trunkValue] of Object.entries(value.trunks)) {
    if (!instanceIds.has(vehicleInstanceId)) {
      errors.push(`trunks.${vehicleInstanceId} does not belong to an owned vehicle`);
      continue;
    }
    const definition = vehicleDefinitionByInstance.get(vehicleInstanceId);
    if (!definition || !isSavedInventoryShape(trunkValue)) {
      if (!isSavedInventoryShape(trunkValue)) {
        errors.push(`trunks.${vehicleInstanceId} is malformed`);
      }
      continue;
    }
    errors.push(...validateTrunk(
      trunkValue,
      definition,
      value.trunkRowBonus,
      itemDefinitions,
      `trunks.${vehicleInstanceId}`,
    ));
    for (const item of trunkValue.items) {
      if (globalItemIds.has(item.instanceId)) {
        errors.push(`trunk item instance "${item.instanceId}" must be globally unique`);
      }
      globalItemIds.add(item.instanceId);
    }
  }
  for (const instanceId of instanceIds) {
    if (!Object.hasOwn(value.trunks, instanceId)) {
      errors.push(`trunks.${instanceId} is required for every owned vehicle`);
    }
  }
  return errors;
}

function validateTrunk(
  trunk: Readonly<SavedInventory>,
  definition: Readonly<VehicleDefinition>,
  rowBonus: TrunkRowBonus,
  itemDefinitions: readonly ItemDefinition[],
  path: string,
): string[] {
  const errors: string[] = [];
  const expected = trunkCapacityFor(definition, rowBonus);
  if (trunk.gridWidth !== expected.gridWidth) {
    errors.push(`${path}.gridWidth must be ${expected.gridWidth}`);
  }
  if (trunk.gridHeight !== expected.gridHeight) {
    errors.push(`${path}.gridHeight must be ${expected.gridHeight}`);
  }
  if (trunk.maxWeightKg !== expected.maxWeightKg) {
    errors.push(`${path}.maxWeightKg must be ${expected.maxWeightKg}`);
  }
  errors.push(...validateInventory(trunk, itemDefinitions).map((error) => `${path}: ${error}`));
  return errors;
}

function firstFreeGarageSlot(vehicles: readonly SavedVehicle[]): number | null {
  const occupied = new Set(vehicles.map((vehicle) => vehicle.garageSlot));
  for (let slot = 0; slot < GARAGE_SLOT_COUNT; slot += 1) {
    if (!occupied.has(slot)) {
      return slot;
    }
  }
  return null;
}

function vehicleCatalog(
  definitions: readonly VehicleDefinition[],
): ReadonlyMap<string, VehicleDefinition> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

function findOwnedVehicle(state: GarageState, instanceId: string): SavedVehicle | undefined {
  return state.ownedVehicles.find((vehicle) => vehicle.instanceId === instanceId);
}

function compareVehicles(left: Readonly<SavedVehicle>, right: Readonly<SavedVehicle>): number {
  return left.garageSlot - right.garageSlot || left.instanceId.localeCompare(right.instanceId);
}

function cloneGarageState(state: Readonly<GarageState>): GarageState {
  const ownedVehicles = state.ownedVehicles.map(cloneVehicle).sort(compareVehicles);
  const trunkKeys = Object.keys(state.trunks).sort((left, right) => left.localeCompare(right));
  return {
    cash: state.cash,
    trunkRowBonus: state.trunkRowBonus,
    ...(state.vehicleRepairDiscountPercent === undefined
      ? {}
      : { vehicleRepairDiscountPercent: state.vehicleRepairDiscountPercent }),
    ownedVehicles,
    trunks: Object.fromEntries(
      trunkKeys.map((instanceId) => [instanceId, cloneInventory(state.trunks[instanceId]!)]),
    ),
  };
}

function cloneVehicle(vehicle: Readonly<SavedVehicle>): SavedVehicle {
  return {
    instanceId: vehicle.instanceId,
    definitionId: vehicle.definitionId,
    registered: vehicle.registered,
    garageSlot: vehicle.garageSlot,
    bodyHealth: vehicle.bodyHealth,
    engineHealth: vehicle.engineHealth,
    tireHealth: [...vehicle.tireHealth],
    upgrades: { ...vehicle.upgrades },
  };
}

function cloneInventory(inventory: Readonly<SavedInventory>): SavedInventory {
  return {
    gridWidth: inventory.gridWidth,
    gridHeight: inventory.gridHeight,
    maxWeightKg: inventory.maxWeightKg,
    items: inventory.items.map((item) => ({ ...item })),
  };
}

function duplicateTrunkItemInstanceId(
  trunks: Readonly<Record<string, SavedInventory>>,
): string | null {
  const seen = new Set<string>();
  for (const trunk of Object.values(trunks)) {
    for (const item of trunk.items) {
      if (seen.has(item.instanceId)) {
        return item.instanceId;
      }
      seen.add(item.instanceId);
    }
  }
  return null;
}

function sameVehicleCondition(
  left: Readonly<SavedVehicle>,
  right: Readonly<SavedVehicle>,
): boolean {
  return left.bodyHealth === right.bodyHealth
    && left.engineHealth === right.engineHealth
    && left.tireHealth.every((health, index) => health === right.tireHealth[index]);
}

function success(
  state: GarageState,
  cost: number,
  vehicleInstanceId: string | null,
): GarageTransactionResult {
  return { success: true, state, cost, vehicleInstanceId };
}

function failure(state: GarageState, reason: string): GarageTransactionResult {
  return { success: false, state, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSavedVehicleShape(value: unknown): value is SavedVehicle {
  if (!isRecord(value) || !isRecord(value.upgrades)) {
    return false;
  }
  return typeof value.instanceId === 'string'
    && typeof value.definitionId === 'string'
    && typeof value.registered === 'boolean'
    && typeof value.garageSlot === 'number'
    && typeof value.bodyHealth === 'number'
    && typeof value.engineHealth === 'number'
    && Array.isArray(value.tireHealth)
    && value.tireHealth.length === 4
    && value.tireHealth.every((health) => typeof health === 'number')
    && typeof value.upgrades.engine === 'number'
    && typeof value.upgrades.brakes === 'number'
    && typeof value.upgrades.grip === 'number'
    && typeof value.upgrades.armor === 'number'
    && typeof value.upgrades.paint === 'string';
}

function isSavedInventoryShape(value: unknown): value is SavedInventory {
  if (
    !isRecord(value)
    || typeof value.gridWidth !== 'number'
    || typeof value.gridHeight !== 'number'
    || typeof value.maxWeightKg !== 'number'
    || !Array.isArray(value.items)
  ) {
    return false;
  }
  return value.items.every(isSavedItemShape);
}

function isSavedItemShape(value: unknown): value is SavedItemInstance {
  return isRecord(value)
    && typeof value.instanceId === 'string'
    && typeof value.definitionId === 'string'
    && typeof value.quantity === 'number'
    && typeof value.durability === 'number'
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.rotated === 'boolean';
}

function isHealth(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function isDamage(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function assertPercent(value: number, label: string): void {
  if (!isPercent(value)) {
    throw new RangeError(`${label} must be between 0 and 100`);
  }
}

function isUpgradeKind(value: unknown): value is VehicleUpgradeKind {
  return value === 'engine' || value === 'brakes' || value === 'grip' || value === 'armor';
}

function isUpgradeTier(value: unknown): value is VehicleUpgradeTier {
  return value === 1 || value === 2 || value === 3;
}

function isRepairScope(value: unknown): value is VehicleRepairScope {
  return value === 'body' || value === 'engine' || value === 'tires' || value === 'all';
}

export function isGaragePaint(value: unknown): value is GaragePaint {
  return typeof value === 'string' && (GARAGE_PAINTS as readonly string[]).includes(value);
}

function isTrunkRowBonus(value: unknown): value is TrunkRowBonus {
  return value === 0 || value === 1;
}

function isSafeVehicleInstanceId(value: string): boolean {
  return VEHICLE_INSTANCE_ID_PATTERN.test(value) && !RESERVED_RECORD_KEYS.has(value);
}

function assertTrunkRowBonus(value: number): asserts value is TrunkRowBonus {
  if (!isTrunkRowBonus(value)) {
    throw new RangeError('trunk row bonus must be 0 or 1');
  }
}
