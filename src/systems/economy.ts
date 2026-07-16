import type { ItemDefinition, PropertyDefinition } from '../data/types';
import type { EndingChoice, SavedProperty } from '../core/state';

export type ShopMarket = 'legitimate' | 'black-market';

export interface EconomyState {
  cash: number;
  properties: Record<string, SavedProperty>;
}

export interface ShopPricingContext {
  market: ShopMarket;
  legitimateDiscountPercent?: number;
  ending?: EndingChoice | null;
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

export interface PropertyCollectionResult {
  state: EconomyState;
  amount: number;
  collectedPropertyIds: readonly string[];
}

export function createEconomyState(cash = 0): EconomyState {
  assertCash(cash);
  return { cash, properties: {} };
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
    state: { ...cloneEconomy(state), cash: Math.min(Number.MAX_SAFE_INTEGER, state.cash + reward) },
    amount: reward,
  };
}

export function spendCash(
  state: Readonly<EconomyState>,
  amount: number,
): EconomyTransactionResult {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return failure(state, 'cash cost must be a non-negative integer');
  }
  if (state.cash < amount) {
    return failure(state, 'not enough cash');
  }
  return { success: true, state: { ...cloneEconomy(state), cash: state.cash - amount }, amount };
}

export function quoteShopPrice(
  basePrice: number,
  quantity: number,
  context: Readonly<ShopPricingContext>,
): number {
  if (!Number.isFinite(basePrice) || basePrice < 0) {
    throw new RangeError('basePrice must be non-negative and finite');
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new RangeError('quantity must be a positive integer');
  }
  const discount = clamp(context.legitimateDiscountPercent ?? 0, 0, 100) / 100;
  let multiplier = context.market === 'legitimate' ? 1 - discount : 1;
  if (context.market === 'black-market' && context.ending === 'rule') {
    multiplier *= 0.9;
  } else if (context.market === 'black-market' && context.ending === 'expose') {
    multiplier *= 1.1;
  }
  return Math.ceil(basePrice * quantity * multiplier - 1e-9);
}

export function purchaseShopItem(
  state: Readonly<EconomyState>,
  definition: Readonly<ItemDefinition>,
  quantity: number,
  context: Readonly<ShopPricingContext>,
): ShopPurchaseResult {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return shopFailure(state, 'quantity must be a positive integer');
  }
  const cost = quoteShopPrice(definition.baseValue, quantity, context);
  const payment = spendCash(state, cost);
  if (!payment.success) {
    return shopFailure(state, payment.reason);
  }
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
  if (!definition.discardable || definition.category === 'quest') {
    return shopFailure(state, 'this item cannot be sold');
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return shopFailure(state, 'quantity must be a positive integer');
  }
  if (!Number.isFinite(resaleRate) || resaleRate < 0 || resaleRate > 1) {
    return shopFailure(state, 'resaleRate must be between 0 and 1');
  }
  const proceeds = Math.floor(definition.baseValue * quantity * resaleRate);
  const earned = earnCash(state, proceeds);
  if (!earned.success) {
    return shopFailure(state, earned.reason);
  }
  return {
    success: true,
    state: earned.state,
    cost: -proceeds,
    grant: { itemId: definition.id, quantity: -quantity },
  };
}

export function purchaseProperty(
  state: Readonly<EconomyState>,
  definition: Readonly<PropertyDefinition>,
): EconomyTransactionResult {
  const current = state.properties[definition.id];
  if (current?.owned) {
    return failure(state, `${definition.id} is already owned`);
  }
  const payment = spendCash(state, definition.purchasePrice);
  if (!payment.success) {
    return payment;
  }
  const next = cloneEconomy(payment.state);
  next.properties[definition.id] = {
    owned: true,
    upgraded: false,
    uncollectedPayouts: 0,
  };
  return { success: true, state: next, amount: definition.purchasePrice };
}

export function upgradeProperty(
  state: Readonly<EconomyState>,
  definition: Readonly<PropertyDefinition>,
): EconomyTransactionResult {
  const current = state.properties[definition.id];
  if (!current?.owned) {
    return failure(state, `${definition.id} must be owned before upgrading`);
  }
  if (current.upgraded) {
    return failure(state, `${definition.id} is already upgraded`);
  }
  const payment = spendCash(state, definition.upgrade.cost);
  if (!payment.success) {
    return payment;
  }
  const next = cloneEconomy(payment.state);
  const property = next.properties[definition.id];
  if (!property) {
    return failure(state, `${definition.id} was not found`);
  }
  property.upgraded = true;
  return { success: true, state: next, amount: definition.upgrade.cost };
}

/** Adds one payout per completed story/side job, respecting each authored cap. */
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
        definition.payoutCap,
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
  for (const definition of definitions) {
    if (propertyId !== 'all' && definition.id !== propertyId) {
      continue;
    }
    const property = next.properties[definition.id];
    if (!property?.owned || property.uncollectedPayouts === 0) {
      continue;
    }
    const upgradeMultiplier = property.upgraded ? definition.upgrade.payoutMultiplier : 1;
    const endingMultiplier = ending === 'rule' ? 1.2 : 1;
    amount += Math.floor(
      definition.basePayout
      * property.uncollectedPayouts
      * upgradeMultiplier
      * endingMultiplier,
    );
    property.uncollectedPayouts = 0;
    collectedPropertyIds.push(definition.id);
  }
  next.cash = Math.min(Number.MAX_SAFE_INTEGER, next.cash + amount);
  return { state: next, amount, collectedPropertyIds };
}

export function propertyPerkMultiplier(
  state: Readonly<EconomyState>,
  definition: Readonly<PropertyDefinition>,
  ending: EndingChoice | null,
): number {
  const property = state.properties[definition.id];
  if (!property?.owned) {
    return 0;
  }
  let multiplier = property.upgraded ? definition.upgrade.perkMultiplier : 1;
  if (ending === 'expose') {
    multiplier *= 1.2;
  }
  return multiplier;
}

function cloneEconomy(state: Readonly<EconomyState>): EconomyState {
  return {
    cash: state.cash,
    properties: Object.fromEntries(
      Object.entries(state.properties).map(([id, property]) => [id, { ...property }]),
    ),
  };
}

function failure(state: Readonly<EconomyState>, reason: string): EconomyTransactionResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function shopFailure(state: Readonly<EconomyState>, reason: string): ShopPurchaseResult {
  return { success: false, state: cloneEconomy(state), reason };
}

function assertCash(cash: number): void {
  if (!Number.isSafeInteger(cash) || cash < 0) {
    throw new RangeError('cash must be a non-negative safe integer');
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
