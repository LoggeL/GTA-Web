import type { EndingChoice, SavedProperty, SavedVehicle } from '../core/state';
import type {
  ActivityDefinition,
  ActivityDifficulty,
  ItemDefinition,
  PropertyDefinition,
  VehicleDefinition,
} from '../data/types';

export const ECONOMY_SNAPSHOT_VERSION = 1 as const;
export const PROPERTY_PAYOUT_CAP = 3 as const;

export const AUTHORED_PROPERTY_IDS = [
  'breakwater-warehouse',
  'neon-strand-club',
  'alta-vista-print-shop',
  'arroyo-diner',
  'coastline-car-wash',
] as const;

export type ShopMarket = 'legitimate' | 'black-market';
export type PropertyPayoutEventKind = 'story-mission' | 'side-job';
export type EconomyServiceKind =
  | 'vehicle-registration'
  | 'vehicle-repair'
  | 'clinic-healing'
  | 'food'
  | 'weapon-repair'
  | 'armor-repair'
  | 'clothing';

/**
 * Cash and property state maps directly to SaveGameV1.player.money and
 * SaveGameV1.properties. The optional ledgers provide runtime idempotency;
 * mission/activity completion state remains the persistent source of truth.
 */
export interface EconomyState {
  cash: number;
  properties: Record<string, SavedProperty>;
  processedTransactionIds?: string[];
  completedPayoutEventIds?: string[];
}

export interface EconomySnapshotV1 extends EconomyState {
  schemaVersion: typeof ECONOMY_SNAPSHOT_VERSION;
  processedTransactionIds: string[];
  completedPayoutEventIds: string[];
}

/** SaveGameV1 projection: money is nested under player in the full save. */
export interface EconomySaveFields {
  money: number;
  properties: Record<string, SavedProperty>;
}

export interface ShopPricingContext {
  market: ShopMarket;
  /** Silver Tongue and other legitimate-only authored discounts. */
  legitimateDiscountPercent?: number;
  ending?: EndingChoice | null;
}

export interface CashRewardContext {
  /** Hustle starts at one and adds 5% cash per added point. */
  hustleLevel?: number;
  sideHustle?: boolean;
  kingpin?: boolean;
  additionalMultiplier?: number;
}

export type EconomyTransactionResult =
  | { success: true; state: EconomyState; amount: number }
  | { success: false; state: EconomyState; reason: string };

export type ShopPurchaseResult =
  | {
    success: true;
    state: EconomyState;
    cost: number;
    grant: { itemId: string; quantity: number };
  }
  | { success: false; state: EconomyState; reason: string };

export interface TransactionalShopPurchaseRequest {
  transactionId: string;
  definition: Readonly<ItemDefinition>;
  quantity: number;
  pricing: Readonly<ShopPricingContext>;
  /** Omit for unlimited stock. */
  availableQuantity?: number;
  /** Set false when an inventory dry-run cannot accept the complete grant. */
  inventoryCanAccept?: boolean;
}

export interface TransactionalShopSaleRequest {
  transactionId: string;
  definition: Readonly<ItemDefinition>;
  quantity: number;
  ownedQuantity: number;
  market: ShopMarket;
  resaleRate?: number;
  durabilityPercent?: number;
}

export type TransactionalShopResult =
  | {
    success: true;
    state: EconomyState;
    transactionId: string;
    cashDelta: number;
    itemDelta: { itemId: string; quantity: number };
  }
  | { success: false; state: EconomyState; reason: string };

export interface TransactionalVehicleSaleRequest {
  transactionId: string;
  vehicle: Readonly<SavedVehicle>;
  definition: Readonly<VehicleDefinition>;
  resaleRate?: number;
  /** Set false when the garage cannot atomically remove the vehicle and trunk. */
  garageCanRemove?: boolean;
}

export type TransactionalVehicleSaleResult =
  | {
    success: true;
    state: EconomyState;
    transactionId: string;
    vehicleInstanceId: string;
    proceeds: number;
  }
  | { success: false; state: EconomyState; reason: string };

export interface PropertyPayoutCompletion {
  eventId: string;
  kind: PropertyPayoutEventKind;
  completed: boolean;
}

export type PropertyPayoutAccrualResult =
  | {
    success: true;
    state: EconomyState;
    eventId: string;
    creditedPropertyIds: readonly string[];
  }
  | { success: false; state: EconomyState; reason: string };

export interface PropertyCollectionResult {
  state: EconomyState;
  amount: number;
  collectedPropertyIds: readonly string[];
  /** Item grants are committed by the inventory transaction after cash/state commit. */
  grants: readonly { itemId: string; quantity: number }[];
}

export interface PropertyServiceModifiers {
  vehicleRegistrationDiscountPercent: number;
  vehicleRepairDiscountPercent: number;
  foodHealingMultiplier: number;
  wantedSearchDurationMultiplier: number;
  servicedVehicleSearchDurationMultiplier: number;
  stashRowBonus: number;
  salvageComponentYieldMultiplier: number;
  contactReputationMultiplier: number;
}

export interface EconomyServiceRequest {
  transactionId: string;
  service: EconomyServiceKind;
  basePrice: number;
  units?: number;
  propertyDefinitions: readonly PropertyDefinition[];
  ending?: EndingChoice | null;
  /** Set false when the target service dry-run would reject or be a no-op. */
  serviceCanApply?: boolean;
}

export type EconomyServiceResult =
  | {
    success: true;
    state: EconomyState;
    transactionId: string;
    cost: number;
    effect: { service: EconomyServiceKind; units: number };
  }
  | { success: false; state: EconomyState; reason: string };

export interface ActivityIncomeQuote {
  activityId: string;
  difficultyId: ActivityDifficulty['id'];
  cash: number;
  xp: number;
  cashMultiplier: number;
  difficultyMultiplier: number;
}

export type ActivityIncomeAwardResult =
  | {
    success: true;
    state: EconomyState;
    transactionId: string;
    cash: number;
    xp: number;
  }
  | { success: false; state: EconomyState; reason: string };

export type EconomyValidationResult =
  | { valid: true; errors: readonly [] }
  | { valid: false; errors: readonly string[] };

export type EconomyRestoreResult =
  | { success: true; state: EconomyState }
  | { success: false; errors: readonly string[] };

const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_LEDGER_ENTRIES = 10_000;
const RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const AUTHORED_PROPERTY_SPEC = {
  'breakwater-warehouse': {
    name: 'Breakwater Warehouse', purchasePrice: 18_000, basePayout: 900,
    upgrade: 'Automated Sorting Bay', perks: ['safehouseStashRows', 'salvageComponentYield'],
  },
  'neon-strand-club': {
    name: 'Neon Strand Club', purchasePrice: 32_000, basePayout: 1_500,
    upgrade: 'Rooftop Lounge', perks: ['propertyPayout', 'contactReputationReward'],
  },
  'alta-vista-print-shop': {
    name: 'Alta Vista Print Shop', purchasePrice: 28_000, basePayout: 1_250,
    upgrade: 'Document Finishing Suite', perks: ['wantedSearchDuration', 'vehicleRegistrationPrice'],
  },
  'arroyo-diner': {
    name: 'Arroyo Diner', purchasePrice: 22_000, basePayout: 1_050,
    upgrade: 'Community Kitchen', perks: ['foodHealing', 'freeHealingItemsPerPayout'],
  },
  'coastline-car-wash': {
    name: 'Coastline Car Wash', purchasePrice: 26_000, basePayout: 1_150,
    upgrade: 'Rapid Detail Tunnel', perks: ['vehicleRepairPrice', 'vehicleSearchDuration'],
  },
} as const;

export function createEconomyState(cash = 0): EconomyState {
  assertCash(cash);
  return { cash, properties: {} };
}

export function createEconomySnapshot(state: Readonly<EconomyState>): EconomySnapshotV1 {
  return {
    schemaVersion: ECONOMY_SNAPSHOT_VERSION,
    ...cloneEconomy(state),
    processedTransactionIds: [...(state.processedTransactionIds ?? [])],
    completedPayoutEventIds: [...(state.completedPayoutEventIds ?? [])],
  };
}

export function validateEconomyState(
  value: unknown,
  definitions?: readonly PropertyDefinition[],
): EconomyValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ['economy state must be an object'] };

  if (value.schemaVersion !== undefined && value.schemaVersion !== ECONOMY_SNAPSHOT_VERSION) {
    errors.push(`schemaVersion must be ${ECONOMY_SNAPSHOT_VERSION}`);
  }
  if (!isNonNegativeSafeInteger(value.cash)) errors.push('cash must be a non-negative safe integer');
  const knownIds = definitions ? new Set(definitions.map((definition) => definition.id)) : null;
  if (!isRecord(value.properties)) {
    errors.push('properties must be an object');
  } else {
    for (const [id, property] of Object.entries(value.properties)) {
      const path = `properties.${id}`;
      if (RESERVED_RECORD_KEYS.has(id) || !TRANSACTION_ID_PATTERN.test(id)) {
        errors.push(`${path} uses an unsafe id`);
      }
      if (knownIds && !knownIds.has(id as PropertyDefinition['id'])) {
        errors.push(`${path} is not in the property catalog`);
      }
      if (!isRecord(property)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      if (typeof property.owned !== 'boolean') errors.push(`${path}.owned must be a boolean`);
      if (typeof property.upgraded !== 'boolean') errors.push(`${path}.upgraded must be a boolean`);
      if (!isIntegerInRange(property.uncollectedPayouts, 0, PROPERTY_PAYOUT_CAP)) {
        errors.push(`${path}.uncollectedPayouts must be an integer between 0 and 3`);
      }
      if (property.owned === false && property.upgraded === true) {
        errors.push(`${path} cannot be upgraded while unowned`);
      }
      if (property.owned === false && typeof property.uncollectedPayouts === 'number'
        && property.uncollectedPayouts !== 0) {
        errors.push(`${path} cannot hold payouts while unowned`);
      }
    }
  }
  validateLedger(value.processedTransactionIds, 'processedTransactionIds', errors);
  validateLedger(value.completedPayoutEventIds, 'completedPayoutEventIds', errors);
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export function restoreEconomyState(
  value: unknown,
  definitions?: readonly PropertyDefinition[],
): EconomyRestoreResult {
  const validation = validateEconomyState(value, definitions);
  if (!validation.valid) return { success: false, errors: validation.errors };
  const source = value as EconomyState;
  return { success: true, state: cloneEconomy(source) };
}

/** Restores the economy projection stored by SaveGameV1. */
export function restoreEconomySaveFields(
  value: unknown,
  definitions?: readonly PropertyDefinition[],
): EconomyRestoreResult {
  if (!isRecord(value)) return { success: false, errors: ['economy save fields must be an object'] };
  return restoreEconomyState({ cash: value.money, properties: value.properties }, definitions);
}

/** Produces the exact immutable patch for player.money and save.properties. */
export function createEconomySaveFields(state: Readonly<EconomyState>): EconomySaveFields {
  assertCash(state.cash);
  return {
    money: state.cash,
    properties: cloneProperties(state.properties),
  };
}

export function earnCash(
  state: Readonly<EconomyState>,
  amount: number,
  rewardMultiplier = 1,
): EconomyTransactionResult {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(rewardMultiplier) || rewardMultiplier < 0) {
    return failure(state, 'cash reward and multiplier must be non-negative and finite');
  }
  const reward = Math.floor(amount * rewardMultiplier);
  return {
    success: true,
    state: { ...cloneEconomy(state), cash: safeCashAdd(state.cash, reward) },
    amount: reward,
  };
}

export function spendCash(
  state: Readonly<EconomyState>,
  amount: number,
): EconomyTransactionResult {
  if (!isNonNegativeSafeInteger(amount)) {
    return failure(state, 'cash cost must be a non-negative integer');
  }
  if (state.cash < amount) return failure(state, 'not enough cash');
  return { success: true, state: { ...cloneEconomy(state), cash: state.cash - amount }, amount };
}

/** Hustle affects earnings, not prices: +5% cash for each point above one. */
export function cashRewardMultiplier(context: Readonly<CashRewardContext> = {}): number {
  const hustleLevel = context.hustleLevel ?? 1;
  if (!isIntegerInRange(hustleLevel, 1, 6)) {
    throw new RangeError('hustleLevel must be an integer between 1 and 6');
  }
  const additional = context.additionalMultiplier ?? 1;
  if (!Number.isFinite(additional) || additional < 0) {
    throw new RangeError('additionalMultiplier must be non-negative and finite');
  }
  return (1 + (hustleLevel - 1) * 0.05)
    * (context.sideHustle ? 1.15 : 1)
    * (context.kingpin ? 1.15 : 1)
    * additional;
}

export function quoteShopPrice(
  basePrice: number,
  quantity: number,
  context: Readonly<ShopPricingContext>,
): number {
  if (!isNonNegativeSafeInteger(basePrice)) {
    throw new RangeError('basePrice must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new RangeError('quantity must be a positive integer');
  }
  assertMarket(context.market);
  const discount = context.legitimateDiscountPercent ?? 0;
  assertPercent(discount, 'legitimateDiscountPercent');
  let multiplier = context.market === 'legitimate' ? 1 - discount / 100 : 1;
  if (context.market === 'black-market' && context.ending === 'rule') multiplier *= 0.9;
  if (context.market === 'black-market' && context.ending === 'expose') multiplier *= 1.1;
  return roundUpPrice(basePrice * quantity * multiplier);
}

export function purchaseShopItem(
  state: Readonly<EconomyState>,
  definition: Readonly<ItemDefinition>,
  quantity: number,
  context: Readonly<ShopPricingContext>,
): ShopPurchaseResult {
  const itemError = validateTradeItem(definition, 'buy');
  if (itemError) return shopFailure(state, itemError);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return shopFailure(state, 'quantity must be a positive integer');
  }
  let cost: number;
  try {
    cost = quoteShopPrice(definition.baseValue, quantity, context);
  } catch (error) {
    return shopFailure(state, errorMessage(error));
  }
  const payment = spendCash(state, cost);
  if (!payment.success) return shopFailure(state, payment.reason);
  return {
    success: true,
    state: payment.state,
    cost,
    grant: { itemId: definition.id, quantity },
  };
}

export function sellShopItem(
  state: Readonly<EconomyState>,
  definition: Readonly<ItemDefinition>,
  quantity: number,
  resaleRate = 0.5,
): ShopPurchaseResult {
  const itemError = validateTradeItem(definition, 'sell');
  if (itemError) return shopFailure(state, itemError);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return shopFailure(state, 'quantity must be a positive integer');
  }
  if (!isRate(resaleRate)) return shopFailure(state, 'resaleRate must be between 0 and 1');
  const proceeds = Math.floor(definition.baseValue * quantity * resaleRate);
  if (!Number.isSafeInteger(proceeds) || state.cash > Number.MAX_SAFE_INTEGER - proceeds) {
    return shopFailure(state, 'cash wallet cannot accept the complete sale proceeds');
  }
  const earned = earnCash(state, proceeds);
  if (!earned.success) return shopFailure(state, earned.reason);
  return {
    success: true,
    state: earned.state,
    cost: -proceeds,
    grant: { itemId: definition.id, quantity: -quantity },
  };
}

export function purchaseShopItemTransactional(
  state: Readonly<EconomyState>,
  request: Readonly<TransactionalShopPurchaseRequest>,
): TransactionalShopResult {
  const transactionError = validateNewTransaction(state, request.transactionId);
  if (transactionError) return transactionalShopFailure(state, transactionError);
  if (request.availableQuantity !== undefined
    && (!isNonNegativeSafeInteger(request.availableQuantity) || request.availableQuantity < request.quantity)) {
    return transactionalShopFailure(state, 'shop stock cannot satisfy the complete purchase');
  }
  if (request.inventoryCanAccept === false) {
    return transactionalShopFailure(state, 'inventory cannot accept the complete purchase');
  }
  const purchase = purchaseShopItem(state, request.definition, request.quantity, request.pricing);
  if (!purchase.success) return transactionalShopFailure(state, purchase.reason);
  const next = recordTransaction(purchase.state, request.transactionId);
  return {
    success: true,
    state: next,
    transactionId: request.transactionId,
    cashDelta: -purchase.cost,
    itemDelta: { ...purchase.grant },
  };
}

export function sellShopItemTransactional(
  state: Readonly<EconomyState>,
  request: Readonly<TransactionalShopSaleRequest>,
): TransactionalShopResult {
  const transactionError = validateNewTransaction(state, request.transactionId);
  if (transactionError) return transactionalShopFailure(state, transactionError);
  if (!isMarket(request.market)) {
    return transactionalShopFailure(state, 'market must be legitimate or black-market');
  }
  if (!Number.isSafeInteger(request.quantity) || request.quantity < 1) {
    return transactionalShopFailure(state, 'quantity must be a positive integer');
  }
  if (!isNonNegativeSafeInteger(request.ownedQuantity) || request.quantity > request.ownedQuantity) {
    return transactionalShopFailure(state, 'sale quantity exceeds owned quantity');
  }
  if (request.definition.category === 'contraband' && request.market !== 'black-market') {
    return transactionalShopFailure(state, 'contraband requires a black-market buyer');
  }
  const itemError = validateTradeItem(request.definition, 'sell');
  if (itemError) return transactionalShopFailure(state, itemError);
  const resaleRate = request.resaleRate ?? 0.5;
  if (!isRate(resaleRate)) return transactionalShopFailure(state, 'resaleRate must be between 0 and 1');
  const durability = request.durabilityPercent ?? 100;
  if (!isPercent(durability)) {
    return transactionalShopFailure(state, 'durabilityPercent must be between 0 and 100');
  }
  if (request.definition.hasDurability && durability === 0) {
    return transactionalShopFailure(state, 'broken items must be repaired before sale');
  }
  const conditionMultiplier = request.definition.hasDurability ? durability / 100 : 1;
  const proceeds = Math.floor(
    request.definition.baseValue * request.quantity * resaleRate * conditionMultiplier,
  );
  if (proceeds <= 0) return transactionalShopFailure(state, 'sale has no cash value');
  if (!Number.isSafeInteger(proceeds)) {
    return transactionalShopFailure(state, 'sale proceeds exceed the safe integer range');
  }
  if (state.cash > Number.MAX_SAFE_INTEGER - proceeds) {
    return transactionalShopFailure(state, 'cash wallet cannot accept the complete sale proceeds');
  }
  const earned = earnCash(state, proceeds);
  if (!earned.success) return transactionalShopFailure(state, earned.reason);
  return {
    success: true,
    state: recordTransaction(earned.state, request.transactionId),
    transactionId: request.transactionId,
    cashDelta: proceeds,
    itemDelta: { itemId: request.definition.id, quantity: -request.quantity },
  };
}

/** Registered civilian vehicles sell for condition-adjusted market value. */
export function quoteRegisteredVehicleSale(
  vehicle: Readonly<SavedVehicle>,
  definition: Readonly<VehicleDefinition>,
  resaleRate = 0.5,
): number {
  if (!vehicle.registered) throw new RangeError('only registered vehicles can be sold');
  if (!definition.registerable || vehicle.definitionId !== definition.id) {
    throw new RangeError('vehicle definition is not an eligible registration match');
  }
  if (!isNonNegativeSafeInteger(definition.baseValue) || definition.baseValue === 0) {
    throw new RangeError('vehicle base value must be a positive safe integer');
  }
  if (!isRate(resaleRate)) throw new RangeError('resaleRate must be between 0 and 1');
  const health = [vehicle.bodyHealth, vehicle.engineHealth, ...vehicle.tireHealth];
  if (health.some((value) => !isPercent(value))) {
    throw new RangeError('vehicle condition must be between 0 and 100');
  }
  const averageCondition = health.reduce((total, value) => total + value, 0) / health.length / 100;
  const conditionMultiplier = Math.max(0.1, averageCondition);
  return Math.floor(definition.baseValue * resaleRate * conditionMultiplier + 1e-9);
}

export function sellRegisteredVehicleTransactional(
  state: Readonly<EconomyState>,
  request: Readonly<TransactionalVehicleSaleRequest>,
): TransactionalVehicleSaleResult {
  const transactionError = validateNewTransaction(state, request.transactionId);
  if (transactionError) return vehicleSaleFailure(state, transactionError);
  if (request.garageCanRemove === false) {
    return vehicleSaleFailure(state, 'garage cannot atomically remove the vehicle and trunk');
  }
  if (!isSafeLedgerId(request.vehicle.instanceId)) {
    return vehicleSaleFailure(state, 'vehicle instance id is invalid');
  }
  let proceeds: number;
  try {
    proceeds = quoteRegisteredVehicleSale(
      request.vehicle,
      request.definition,
      request.resaleRate,
    );
  } catch (error) {
    return vehicleSaleFailure(state, errorMessage(error));
  }
  if (!isNonNegativeSafeInteger(proceeds) || proceeds === 0) {
    return vehicleSaleFailure(state, 'vehicle sale has no safe cash value');
  }
  if (state.cash > Number.MAX_SAFE_INTEGER - proceeds) {
    return vehicleSaleFailure(state, 'cash wallet cannot accept the complete vehicle proceeds');
  }
  const earned = earnCash(state, proceeds);
  if (!earned.success) return vehicleSaleFailure(state, earned.reason);
  return {
    success: true,
    state: recordTransaction(earned.state, request.transactionId),
    transactionId: request.transactionId,
    vehicleInstanceId: request.vehicle.instanceId,
    proceeds,
  };
}

export function purchaseProperty(
  state: Readonly<EconomyState>,
  definition: Readonly<PropertyDefinition>,
): EconomyTransactionResult {
  const definitionError = validatePropertyDefinition(definition);
  if (definitionError) return failure(state, definitionError);
  const current = state.properties[definition.id];
  if (current?.owned) return failure(state, `${definition.id} is already owned`);
  const payment = spendCash(state, definition.purchasePrice);
  if (!payment.success) return payment;
  const next = cloneEconomy(payment.state);
  next.properties[definition.id] = { owned: true, upgraded: false, uncollectedPayouts: 0 };
  return { success: true, state: next, amount: definition.purchasePrice };
}

export function upgradeProperty(
  state: Readonly<EconomyState>,
  definition: Readonly<PropertyDefinition>,
): EconomyTransactionResult {
  const definitionError = validatePropertyDefinition(definition);
  if (definitionError) return failure(state, definitionError);
  const current = state.properties[definition.id];
  if (!current?.owned) return failure(state, `${definition.id} must be owned before upgrading`);
  if (current.upgraded) return failure(state, `${definition.id} is already upgraded`);
  const payment = spendCash(state, definition.upgrade.cost);
  if (!payment.success) return payment;
  const next = cloneEconomy(payment.state);
  const property = next.properties[definition.id];
  if (!property) return failure(state, `${definition.id} was not found`);
  property.upgraded = true;
  return { success: true, state: next, amount: definition.upgrade.cost };
}

/** Canonical one-event accrual path for completed story missions and side jobs. */
export function accruePropertyPayoutForCompletion(
  state: Readonly<EconomyState>,
  definitions: readonly PropertyDefinition[],
  completion: Readonly<PropertyPayoutCompletion>,
): PropertyPayoutAccrualResult {
  if (!completion.completed) return payoutFailure(state, 'only completed missions or jobs accrue payouts');
  if (completion.kind !== 'story-mission' && completion.kind !== 'side-job') {
    return payoutFailure(state, 'payout event kind must be story-mission or side-job');
  }
  if (!isSafeLedgerId(completion.eventId)) return payoutFailure(state, 'payout event id is invalid');
  if ((state.completedPayoutEventIds ?? []).includes(completion.eventId)) {
    return payoutFailure(state, `payout event "${completion.eventId}" was already processed`);
  }
  if ((state.completedPayoutEventIds?.length ?? 0) >= MAX_LEDGER_ENTRIES) {
    return payoutFailure(state, 'payout event ledger is full');
  }

  const next = cloneEconomy(state);
  const creditedPropertyIds: string[] = [];
  const seenPropertyIds = new Set<string>();
  for (const definition of definitions) {
    if (seenPropertyIds.has(definition.id)) continue;
    seenPropertyIds.add(definition.id);
    const property = next.properties[definition.id];
    if (property?.owned && property.uncollectedPayouts < PROPERTY_PAYOUT_CAP) {
      property.uncollectedPayouts = Math.min(
        PROPERTY_PAYOUT_CAP,
        property.uncollectedPayouts + 1,
      );
      creditedPropertyIds.push(definition.id);
    }
  }
  next.completedPayoutEventIds = [...(next.completedPayoutEventIds ?? []), completion.eventId];
  return { success: true, state: next, eventId: completion.eventId, creditedPropertyIds };
}

/** Trusted batch helper used by migration/tests; live play should use the event API above. */
export function accruePropertyPayouts(
  state: Readonly<EconomyState>,
  definitions: readonly PropertyDefinition[],
  completedJobs = 1,
): EconomyState {
  if (!Number.isSafeInteger(completedJobs) || completedJobs < 0) {
    throw new RangeError('completedJobs must be a non-negative integer');
  }
  const next = cloneEconomy(state);
  for (const definition of definitions) {
    const property = next.properties[definition.id];
    if (property?.owned) {
      property.uncollectedPayouts = Math.min(
        PROPERTY_PAYOUT_CAP,
        property.uncollectedPayouts + completedJobs,
      );
    }
  }
  return next;
}

export function collectPropertyIncome(
  state: Readonly<EconomyState>,
  definitions: readonly PropertyDefinition[],
  propertyId: string | 'all',
  ending: EndingChoice | null = null,
): PropertyCollectionResult {
  const next = cloneEconomy(state);
  let amount = 0;
  const collectedPropertyIds: string[] = [];
  const grants = new Map<string, number>();
  for (const definition of definitions) {
    if (propertyId !== 'all' && definition.id !== propertyId) continue;
    const property = next.properties[definition.id];
    if (!property?.owned || property.uncollectedPayouts === 0) continue;

    const payoutCount = property.uncollectedPayouts;
    const payout = propertyIncomeForPayouts(state, definition, payoutCount, ending);
    amount = safeCashAdd(amount, payout);
    if (definition.id === 'arroyo-diner') {
      const freeItems = Math.floor(
        payoutCount * propertyPerkValueForDefinition(state, definition, 'freeHealingItemsPerPayout', ending),
      );
      if (freeItems > 0) grants.set('medkit', (grants.get('medkit') ?? 0) + freeItems);
    }
    property.uncollectedPayouts = 0;
    collectedPropertyIds.push(definition.id);
  }
  if (state.cash > Number.MAX_SAFE_INTEGER - amount) {
    return { state: cloneEconomy(state), amount: 0, collectedPropertyIds: [], grants: [] };
  }
  next.cash += amount;
  return {
    state: next,
    amount,
    collectedPropertyIds,
    grants: [...grants].map(([itemId, quantity]) => ({ itemId, quantity })),
  };
}

export function propertyIncomeForPayouts(
  state: Readonly<EconomyState>,
  definition: Readonly<PropertyDefinition>,
  payoutCount: number,
  ending: EndingChoice | null = null,
): number {
  if (!isIntegerInRange(payoutCount, 0, PROPERTY_PAYOUT_CAP)) {
    throw new RangeError('payoutCount must be an integer between 0 and 3');
  }
  const property = state.properties[definition.id];
  if (!property?.owned || payoutCount === 0) return 0;
  const upgradeMultiplier = property.upgraded ? definition.upgrade.payoutMultiplier : 1;
  const endingMultiplier = ending === 'rule' ? 1.2 : 1;
  const propertyPayoutBonus = propertyPerkValueForDefinition(
    state,
    definition,
    'propertyPayout',
    ending,
  );
  return Math.floor(
    definition.basePayout
    * payoutCount
    * upgradeMultiplier
    * (1 + propertyPayoutBonus / 100)
    * endingMultiplier
    + 1e-9,
  );
}

export function propertyPerkMultiplier(
  state: Readonly<EconomyState>,
  definition: Readonly<PropertyDefinition>,
  ending: EndingChoice | null,
): number {
  const property = state.properties[definition.id];
  if (!property?.owned) return 0;
  let multiplier = property.upgraded ? definition.upgrade.perkMultiplier : 1;
  if (ending === 'expose') multiplier *= 1.2;
  return multiplier;
}

export function propertyPerkValue(
  state: Readonly<EconomyState>,
  definitions: readonly PropertyDefinition[],
  stat: string,
  ending: EndingChoice | null = null,
): number {
  return definitions.reduce(
    (total, definition) => total + propertyPerkValueForDefinition(state, definition, stat, ending),
    0,
  );
}

export function resolvePropertyServiceModifiers(
  state: Readonly<EconomyState>,
  definitions: readonly PropertyDefinition[],
  ending: EndingChoice | null = null,
): PropertyServiceModifiers {
  const registration = -propertyPerkValue(state, definitions, 'vehicleRegistrationPrice', ending);
  const vehicleRepair = -propertyPerkValue(state, definitions, 'vehicleRepairPrice', ending);
  const foodHealing = propertyPerkValue(state, definitions, 'foodHealing', ending);
  const wantedSearch = propertyPerkValue(state, definitions, 'wantedSearchDuration', ending);
  const vehicleSearch = propertyPerkValue(state, definitions, 'vehicleSearchDuration', ending);
  const stashRows = propertyPerkValue(state, definitions, 'safehouseStashRows', ending);
  const salvageYield = propertyPerkValue(state, definitions, 'salvageComponentYield', ending);
  const reputation = propertyPerkValue(state, definitions, 'contactReputationReward', ending);
  return {
    vehicleRegistrationDiscountPercent: roundEconomic(clamp(registration, 0, 100)),
    vehicleRepairDiscountPercent: roundEconomic(clamp(vehicleRepair, 0, 100)),
    foodHealingMultiplier: roundEconomic(Math.max(0, 1 + foodHealing / 100)),
    wantedSearchDurationMultiplier: roundEconomic(Math.max(0, 1 + wantedSearch / 100)),
    servicedVehicleSearchDurationMultiplier: roundEconomic(Math.max(0, 1 + vehicleSearch / 100)),
    stashRowBonus: Math.max(0, Math.floor(stashRows)),
    salvageComponentYieldMultiplier: roundEconomic(Math.max(0, 1 + salvageYield / 100)),
    contactReputationMultiplier: roundEconomic(Math.max(0, 1 + reputation / 100)),
  };
}

export function quoteServicePrice(
  state: Readonly<EconomyState>,
  request: Omit<EconomyServiceRequest, 'transactionId'>,
): number {
  if (!isNonNegativeSafeInteger(request.basePrice)) {
    throw new RangeError('service basePrice must be a non-negative safe integer');
  }
  const units = request.units ?? 1;
  if (!Number.isSafeInteger(units) || units < 1) {
    throw new RangeError('service units must be a positive integer');
  }
  if (!isServiceKind(request.service)) {
    throw new RangeError('service kind is invalid');
  }
  const modifiers = resolvePropertyServiceModifiers(
    state,
    request.propertyDefinitions,
    request.ending ?? null,
  );
  const discount = request.service === 'vehicle-registration'
    ? modifiers.vehicleRegistrationDiscountPercent
    : request.service === 'vehicle-repair'
      ? modifiers.vehicleRepairDiscountPercent
      : 0;
  return roundUpPrice(request.basePrice * units * (1 - discount / 100));
}

export function purchaseService(
  state: Readonly<EconomyState>,
  request: Readonly<EconomyServiceRequest>,
): EconomyServiceResult {
  const transactionError = validateNewTransaction(state, request.transactionId);
  if (transactionError) return serviceFailure(state, transactionError);
  if (request.serviceCanApply === false) {
    return serviceFailure(state, 'service cannot be applied to the current target');
  }
  let cost: number;
  try {
    cost = quoteServicePrice(state, request);
  } catch (error) {
    return serviceFailure(state, errorMessage(error));
  }
  const payment = spendCash(state, cost);
  if (!payment.success) return serviceFailure(state, payment.reason);
  return {
    success: true,
    state: recordTransaction(payment.state, request.transactionId),
    transactionId: request.transactionId,
    cost,
    effect: { service: request.service, units: request.units ?? 1 },
  };
}

export function quoteActivityIncome(
  definition: Readonly<ActivityDefinition>,
  difficultyId: ActivityDifficulty['id'],
  context: Readonly<CashRewardContext> = {},
): ActivityIncomeQuote {
  const difficulty = definition.difficulties.find((entry) => entry.id === difficultyId);
  if (!difficulty) throw new RangeError(`unknown activity difficulty "${difficultyId}"`);
  if (!isNonNegativeSafeInteger(definition.baseCash) || !isNonNegativeSafeInteger(definition.baseXp)) {
    throw new RangeError('activity base cash and xp must be non-negative safe integers');
  }
  if (!Number.isFinite(difficulty.rewardMultiplier) || difficulty.rewardMultiplier < 0) {
    throw new RangeError('activity difficulty reward multiplier must be non-negative and finite');
  }
  const cashMultiplier = cashRewardMultiplier(context);
  return {
    activityId: definition.id,
    difficultyId,
    cash: Math.floor(definition.baseCash * difficulty.rewardMultiplier * cashMultiplier),
    xp: Math.floor(definition.baseXp * difficulty.rewardMultiplier),
    cashMultiplier,
    difficultyMultiplier: difficulty.rewardMultiplier,
  };
}

export function awardActivityIncome(
  state: Readonly<EconomyState>,
  transactionId: string,
  quote: Readonly<ActivityIncomeQuote>,
): ActivityIncomeAwardResult {
  const transactionError = validateNewTransaction(state, transactionId);
  if (transactionError) return activityFailure(state, transactionError);
  if (!isNonNegativeSafeInteger(quote.cash) || !isNonNegativeSafeInteger(quote.xp)) {
    return activityFailure(state, 'activity cash and xp must be non-negative safe integers');
  }
  if (state.cash > Number.MAX_SAFE_INTEGER - quote.cash) {
    return activityFailure(state, 'cash wallet cannot accept the complete activity reward');
  }
  const earned = earnCash(state, quote.cash);
  if (!earned.success) return activityFailure(state, earned.reason);
  return {
    success: true,
    state: recordTransaction(earned.state, transactionId),
    transactionId,
    cash: quote.cash,
    xp: quote.xp,
  };
}

/** Validates that the data registry contains exactly the five authored properties. */
export function validateAuthoredPropertyCatalog(
  definitions: readonly PropertyDefinition[],
): readonly string[] {
  const errors: string[] = [];
  const catalog = new Map(definitions.map((definition) => [definition.id, definition]));
  if (definitions.length !== AUTHORED_PROPERTY_IDS.length || catalog.size !== AUTHORED_PROPERTY_IDS.length) {
    errors.push(`property catalog must contain exactly ${AUTHORED_PROPERTY_IDS.length} unique entries`);
  }
  for (const id of AUTHORED_PROPERTY_IDS) {
    const definition = catalog.get(id);
    const spec = AUTHORED_PROPERTY_SPEC[id];
    if (!definition) {
      errors.push(`missing authored property "${id}"`);
      continue;
    }
    if (definition.name !== spec.name) errors.push(`${id} has the wrong name`);
    if (definition.purchasePrice !== spec.purchasePrice) errors.push(`${id} has the wrong purchase price`);
    if (definition.basePayout !== spec.basePayout) errors.push(`${id} has the wrong base payout`);
    if (definition.payoutCap !== PROPERTY_PAYOUT_CAP) errors.push(`${id} payout cap must be three`);
    if (definition.upgrade.name !== spec.upgrade) errors.push(`${id} has the wrong upgrade`);
    if (definition.upgrade.cost !== definition.purchasePrice * 0.5) {
      errors.push(`${id} upgrade must cost 50% of purchase price`);
    }
    if (definition.upgrade.payoutMultiplier !== 1.5 || definition.upgrade.perkMultiplier !== 1.5) {
      errors.push(`${id} upgrade multipliers must both be 1.5`);
    }
    const perks = definition.perks.map((perk) => perk.stat).sort();
    if (perks.join('|') !== [...spec.perks].sort().join('|')) errors.push(`${id} has the wrong perks`);
  }
  for (const definition of definitions) {
    if (!AUTHORED_PROPERTY_IDS.includes(definition.id)) {
      errors.push(`unexpected property "${definition.id}"`);
    }
  }
  return errors;
}

function propertyPerkValueForDefinition(
  state: Readonly<EconomyState>,
  definition: Readonly<PropertyDefinition>,
  stat: string,
  ending: EndingChoice | null,
): number {
  const multiplier = propertyPerkMultiplier(state, definition, ending);
  if (multiplier === 0) return 0;
  return definition.perks
    .filter((perk) => perk.stat === stat)
    .reduce((total, perk) => total + perk.amount * multiplier, 0);
}

function validateTradeItem(definition: Readonly<ItemDefinition>, action: 'buy' | 'sell'): string | null {
  if (!isNonNegativeSafeInteger(definition.baseValue)) return 'item base value must be a non-negative integer';
  if (definition.category === 'quest' || !definition.discardable) {
    return `this item cannot be ${action === 'buy' ? 'purchased' : 'sold'}`;
  }
  if (definition.baseValue === 0) return 'this item has no trade value';
  return null;
}

function validatePropertyDefinition(definition: Readonly<PropertyDefinition>): string | null {
  if (!isNonNegativeSafeInteger(definition.purchasePrice) || definition.purchasePrice === 0) {
    return 'property purchase price must be a positive safe integer';
  }
  if (!isNonNegativeSafeInteger(definition.basePayout) || definition.basePayout === 0) {
    return 'property payout must be a positive safe integer';
  }
  if (definition.payoutCap !== PROPERTY_PAYOUT_CAP) return 'property payout cap must be three';
  if (definition.upgrade.cost !== definition.purchasePrice * 0.5) {
    return 'property upgrade must cost 50% of purchase price';
  }
  if (definition.upgrade.payoutMultiplier !== 1.5 || definition.upgrade.perkMultiplier !== 1.5) {
    return 'property upgrade multipliers must both be 1.5';
  }
  return null;
}

function cloneEconomy(state: Readonly<EconomyState>): EconomyState {
  const next: EconomyState = {
    cash: state.cash,
    properties: cloneProperties(state.properties),
  };
  if (state.processedTransactionIds !== undefined) {
    next.processedTransactionIds = [...state.processedTransactionIds];
  }
  if (state.completedPayoutEventIds !== undefined) {
    next.completedPayoutEventIds = [...state.completedPayoutEventIds];
  }
  return next;
}

function cloneProperties(properties: Readonly<Record<string, SavedProperty>>): Record<string, SavedProperty> {
  return Object.fromEntries(
    Object.entries(properties).map(([id, property]) => [id, { ...property }]),
  );
}

function validateNewTransaction(state: Readonly<EconomyState>, transactionId: string): string | null {
  if (!isSafeLedgerId(transactionId)) return 'transaction id is invalid';
  if ((state.processedTransactionIds ?? []).includes(transactionId)) {
    return `transaction "${transactionId}" was already processed`;
  }
  if ((state.processedTransactionIds?.length ?? 0) >= MAX_LEDGER_ENTRIES) {
    return 'transaction ledger is full';
  }
  return null;
}

function recordTransaction(state: Readonly<EconomyState>, transactionId: string): EconomyState {
  const next = cloneEconomy(state);
  next.processedTransactionIds = [...(next.processedTransactionIds ?? []), transactionId];
  return next;
}

function validateLedger(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length > MAX_LEDGER_ENTRIES) errors.push(`${path} cannot exceed ${MAX_LEDGER_ENTRIES} entries`);
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !isSafeLedgerId(entry)) {
      errors.push(`${path}[${index}] is invalid`);
    } else if (seen.has(entry)) {
      errors.push(`${path}[${index}] is duplicated`);
    } else {
      seen.add(entry);
    }
  });
}

function failure(state: Readonly<EconomyState>, reason: string): EconomyTransactionResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function shopFailure(state: Readonly<EconomyState>, reason: string): ShopPurchaseResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function transactionalShopFailure(state: Readonly<EconomyState>, reason: string): TransactionalShopResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function payoutFailure(state: Readonly<EconomyState>, reason: string): PropertyPayoutAccrualResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function serviceFailure(state: Readonly<EconomyState>, reason: string): EconomyServiceResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function activityFailure(state: Readonly<EconomyState>, reason: string): ActivityIncomeAwardResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function vehicleSaleFailure(state: Readonly<EconomyState>, reason: string): TransactionalVehicleSaleResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function assertCash(cash: number): void {
  if (!isNonNegativeSafeInteger(cash)) {
    throw new RangeError('cash must be a non-negative safe integer');
  }
}

function assertMarket(market: ShopMarket): void {
  if (!isMarket(market)) {
    throw new RangeError('market must be legitimate or black-market');
  }
}

function isMarket(market: string): market is ShopMarket {
  return market === 'legitimate' || market === 'black-market';
}

function assertPercent(value: number, label: string): void {
  if (!isPercent(value)) throw new RangeError(`${label} must be between 0 and 100`);
}

function isPercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function isRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isSafeLedgerId(value: string): boolean {
  return TRANSACTION_ID_PATTERN.test(value) && !RESERVED_RECORD_KEYS.has(value);
}

function safeCashAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function roundUpPrice(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('price exceeds the safe integer range');
  }
  return Math.ceil(value - 1e-9);
}

function roundEconomic(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isServiceKind(value: string): value is EconomyServiceKind {
  return [
    'vehicle-registration',
    'vehicle-repair',
    'clinic-healing',
    'food',
    'weapon-repair',
    'armor-repair',
    'clothing',
  ].includes(value as EconomyServiceKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
