import { describe, expect, it } from 'vitest';

import { ACTIVITIES, PROPERTIES } from '../../src/data/economy';
import { ITEMS } from '../../src/data/items';
import { VEHICLES } from '../../src/data/vehicles';
import type { ItemDefinition, PropertyDefinition } from '../../src/data/types';
import {
  accruePropertyPayoutForCompletion,
  accruePropertyPayouts,
  awardActivityIncome,
  cashRewardMultiplier,
  collectPropertyIncome,
  createEconomySaveFields,
  createEconomySnapshot,
  createEconomyState,
  earnCash,
  propertyIncomeForPayouts,
  propertyPerkMultiplier,
  purchaseProperty,
  purchaseService,
  purchaseShopItem,
  purchaseShopItemTransactional,
  quoteActivityIncome,
  quoteRegisteredVehicleSale,
  quoteServicePrice,
  quoteShopPrice,
  resolvePropertyServiceModifiers,
  restoreEconomyState,
  restoreEconomySaveFields,
  sellShopItem,
  sellShopItemTransactional,
  sellRegisteredVehicleTransactional,
  spendCash,
  upgradeProperty,
  validateAuthoredPropertyCatalog,
  validateEconomyState,
  type EconomyState,
} from '../../src/systems/economy';

const ITEM: ItemDefinition = {
  id: 'medkit', name: 'Medkit', description: '', category: 'consumable',
  shape: { width: 1, height: 1 }, weightKg: 1, maximumStack: 3,
  baseValue: 100, hasDurability: false, discardable: true,
};

const QUEST_ITEM: ItemDefinition = {
  ...ITEM,
  id: 'quest-test',
  category: 'quest',
  baseValue: 0,
  discardable: false,
};

const PROPERTY: PropertyDefinition = {
  id: 'arroyo-diner',
  name: 'Diner',
  district: 'arroyo-heights',
  description: '',
  purchasePrice: 1_000,
  basePayout: 100,
  payoutCap: 3,
  upgrade: {
    name: 'Kitchen', cost: 500, payoutMultiplier: 1.5, perkMultiplier: 1.5,
  },
  perks: [{ stat: 'healing', amount: 20, unit: 'percent', description: '' }],
};

function requireItem(id: string): ItemDefinition {
  const definition = ITEMS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`missing item ${id}`);
  return definition;
}

function requireProperty(id: PropertyDefinition['id']): PropertyDefinition {
  const definition = PROPERTIES.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`missing property ${id}`);
  return definition;
}

function ownProperties(
  ids: readonly PropertyDefinition['id'][],
  upgraded = false,
  payouts = 0,
  cash = 100_000,
): EconomyState {
  return {
    cash,
    properties: Object.fromEntries(ids.map((id) => [id, {
      owned: true,
      upgraded,
      uncollectedPayouts: payouts,
    }])),
  };
}

describe('economy cash and pricing', () => {
  it('earns and spends cash without mutating prior state', () => {
    const initial = createEconomyState(100);
    const earned = earnCash(initial, 50, 1.2);
    expect(earned).toEqual(expect.objectContaining({ success: true, amount: 60 }));
    if (!earned.success) return;
    expect(earned.state.cash).toBe(160);
    expect(initial.cash).toBe(100);

    const spent = spendCash(earned.state, 70);
    expect(spent.success && spent.state.cash).toBe(90);
    expect(spendCash(initial, 101).success).toBe(false);
    expect(spendCash(initial, -1).success).toBe(false);
  });

  it('uses Hustle for cash earnings and endings for black-market prices', () => {
    expect(cashRewardMultiplier({ hustleLevel: 1 })).toBe(1);
    expect(cashRewardMultiplier({ hustleLevel: 6 })).toBe(1.25);
    expect(cashRewardMultiplier({ hustleLevel: 6, sideHustle: true, kingpin: true }))
      .toBeCloseTo(1.653125);
    expect(() => cashRewardMultiplier({ hustleLevel: 7 })).toThrow('hustleLevel');

    expect(quoteShopPrice(100, 2, {
      market: 'legitimate', legitimateDiscountPercent: 10,
    })).toBe(180);
    expect(quoteShopPrice(100, 2, { market: 'black-market', ending: 'rule' })).toBe(180);
    expect(quoteShopPrice(100, 2, { market: 'black-market', ending: 'expose' })).toBe(220);
    expect(() => quoteShopPrice(100, 1, {
      market: 'legitimate', legitimateDiscountPercent: 101,
    })).toThrow('legitimateDiscountPercent');
  });

  it('saturates oversized rewards without losing safe-integer cash semantics', () => {
    const result = earnCash(createEconomyState(Number.MAX_SAFE_INTEGER - 5), 100);
    expect(result.success && result.state.cash).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('transactional shops', () => {
  it('purchases complete grants only when cash, stock, and inventory permit', () => {
    const initial = createEconomyState(500);
    const purchased = purchaseShopItemTransactional(initial, {
      transactionId: 'shop:medkit:001',
      definition: ITEM,
      quantity: 3,
      pricing: { market: 'legitimate' },
      availableQuantity: 3,
      inventoryCanAccept: true,
    });
    expect(purchased).toEqual(expect.objectContaining({
      success: true,
      cashDelta: -300,
      itemDelta: { itemId: 'medkit', quantity: 3 },
    }));
    if (!purchased.success) return;
    expect(purchased.state.cash).toBe(200);
    expect(purchased.state.processedTransactionIds).toEqual(['shop:medkit:001']);
    expect(initial).toEqual({ cash: 500, properties: {} });

    const duplicate = purchaseShopItemTransactional(purchased.state, {
      transactionId: 'shop:medkit:001',
      definition: ITEM,
      quantity: 3,
      pricing: { market: 'legitimate' },
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.state.cash).toBe(200);

    expect(purchaseShopItemTransactional(initial, {
      transactionId: 'shop:stock', definition: ITEM, quantity: 3,
      pricing: { market: 'legitimate' }, availableQuantity: 2,
    }).success).toBe(false);
    expect(purchaseShopItemTransactional(initial, {
      transactionId: 'shop:capacity', definition: ITEM, quantity: 1,
      pricing: { market: 'legitimate' }, inventoryCanAccept: false,
    }).success).toBe(false);
  });

  it('rejects quest/non-trade goods and insufficient cash before producing grants', () => {
    expect(purchaseShopItem(createEconomyState(500), QUEST_ITEM, 1, {
      market: 'legitimate',
    }).success).toBe(false);
    expect(purchaseShopItem(createEconomyState(50), ITEM, 1, {
      market: 'legitimate',
    }).success).toBe(false);
    expect(sellShopItem(createEconomyState(), QUEST_ITEM, 1).success).toBe(false);
  });

  it('sells only owned, valid goods and scales durable resale by condition', () => {
    const armor = requireItem('armor-light');
    const initial = createEconomyState(100);
    const sold = sellShopItemTransactional(initial, {
      transactionId: 'sale:armor:001',
      definition: armor,
      quantity: 1,
      ownedQuantity: 1,
      market: 'legitimate',
      durabilityPercent: 50,
    });
    expect(sold).toEqual(expect.objectContaining({
      success: true,
      cashDelta: 237,
      itemDelta: { itemId: 'armor-light', quantity: -1 },
    }));
    if (!sold.success) return;
    expect(sold.state.cash).toBe(337);
    expect(sellShopItemTransactional(sold.state, {
      transactionId: 'sale:armor:001', definition: armor, quantity: 1,
      ownedQuantity: 1, market: 'legitimate', durabilityPercent: 50,
    }).success).toBe(false);
    expect(sellShopItemTransactional(initial, {
      transactionId: 'sale:too-many', definition: armor, quantity: 2,
      ownedQuantity: 1, market: 'legitimate',
    }).success).toBe(false);
    expect(sellShopItemTransactional(initial, {
      transactionId: 'sale:broken', definition: armor, quantity: 1,
      ownedQuantity: 1, market: 'legitimate', durabilityPercent: 0,
    }).success).toBe(false);
  });

  it('requires specialist black-market buyers for contraband', () => {
    const contraband = requireItem('contraband-bond-roll');
    const request = {
      definition: contraband,
      quantity: 1,
      ownedQuantity: 1,
    } as const;
    expect(sellShopItemTransactional(createEconomyState(), {
      ...request, transactionId: 'sale:bonds:legit', market: 'legitimate',
    }).success).toBe(false);
    expect(sellShopItemTransactional(createEconomyState(), {
      ...request, transactionId: 'sale:bonds:black', market: 'black-market',
    }).success).toBe(true);
  });

  it('sells registered civilian vehicles only when the garage can remove them atomically', () => {
    const definition = VEHICLES[0]!;
    const vehicle = {
      instanceId: 'owned:compact:1',
      definitionId: definition.id,
      registered: true,
      garageSlot: 0,
      bodyHealth: 100,
      engineHealth: 100,
      tireHealth: [100, 100, 100, 100] as [number, number, number, number],
      upgrades: { engine: 0, brakes: 0, grip: 0, armor: 0, paint: 'factory' },
    };
    expect(quoteRegisteredVehicleSale(vehicle, definition)).toBe(3_400);
    const sold = sellRegisteredVehicleTransactional(createEconomyState(100), {
      transactionId: 'vehicle-sale:compact:1', vehicle, definition, garageCanRemove: true,
    });
    expect(sold).toEqual(expect.objectContaining({
      success: true, proceeds: 3_400, vehicleInstanceId: 'owned:compact:1',
    }));
    if (!sold.success) return;
    expect(sold.state.cash).toBe(3_500);
    expect(sellRegisteredVehicleTransactional(sold.state, {
      transactionId: 'vehicle-sale:compact:1', vehicle, definition,
    }).success).toBe(false);
    expect(sellRegisteredVehicleTransactional(createEconomyState(), {
      transactionId: 'vehicle-sale:blocked', vehicle, definition, garageCanRemove: false,
    }).success).toBe(false);
    expect(sellRegisteredVehicleTransactional(createEconomyState(), {
      transactionId: 'vehicle-sale:unregistered',
      vehicle: { ...vehicle, registered: false },
      definition,
    }).success).toBe(false);
  });
});

describe('authored properties and payout transactions', () => {
  it('validates all five exact authored properties and their sole paid upgrades', () => {
    expect(validateAuthoredPropertyCatalog(PROPERTIES)).toEqual([]);
    expect(PROPERTIES.map((property) => property.id)).toEqual([
      'breakwater-warehouse',
      'neon-strand-club',
      'alta-vista-print-shop',
      'arroyo-diner',
      'coastline-car-wash',
    ]);
    for (const property of PROPERTIES) {
      expect(property.upgrade.cost).toBe(property.purchasePrice * 0.5);
      expect(property.upgrade.payoutMultiplier).toBe(1.5);
      expect(property.upgrade.perkMultiplier).toBe(1.5);
      expect(property.payoutCap).toBe(3);
    }

    const altered = PROPERTIES.map((property, index) => (
      index === 0 ? { ...property, purchasePrice: property.purchasePrice + 1 } : property
    ));
    expect(validateAuthoredPropertyCatalog(altered)).toContain(
      'breakwater-warehouse has the wrong purchase price',
    );
  });

  it('purchases and upgrades a property exactly once without mutating failures', () => {
    const initial = createEconomyState(2_000);
    const purchase = purchaseProperty(initial, PROPERTY);
    expect(purchase.success).toBe(true);
    if (!purchase.success) return;
    expect(purchase.state.cash).toBe(1_000);
    expect(purchase.state.properties[PROPERTY.id]).toEqual({
      owned: true, upgraded: false, uncollectedPayouts: 0,
    });
    expect(purchaseProperty(purchase.state, PROPERTY).success).toBe(false);

    const upgrade = upgradeProperty(purchase.state, PROPERTY);
    expect(upgrade.success).toBe(true);
    if (!upgrade.success) return;
    expect(upgrade.state.cash).toBe(500);
    expect(upgrade.state.properties[PROPERTY.id]?.upgraded).toBe(true);
    const duplicate = upgradeProperty(upgrade.state, PROPERTY);
    expect(duplicate.success).toBe(false);
    expect(duplicate.state.cash).toBe(500);
  });

  it('accrues exactly once only for completed mission/job events and caps at three', () => {
    const owned = ownProperties(['arroyo-diner'], false, 0, 0);
    const incomplete = accruePropertyPayoutForCompletion(owned, PROPERTIES, {
      eventId: 'mission:tutorial', kind: 'story-mission', completed: false,
    });
    expect(incomplete.success).toBe(false);
    expect(incomplete.state.properties['arroyo-diner']?.uncollectedPayouts).toBe(0);

    let state = owned;
    for (const eventId of ['mission:tutorial', 'job:race:1', 'job:race:2', 'job:race:3']) {
      const result = accruePropertyPayoutForCompletion(state, PROPERTIES, {
        eventId,
        kind: eventId.startsWith('mission') ? 'story-mission' : 'side-job',
        completed: true,
      });
      expect(result.success).toBe(true);
      if (result.success) state = result.state;
    }
    expect(state.properties['arroyo-diner']?.uncollectedPayouts).toBe(3);
    const duplicate = accruePropertyPayoutForCompletion(state, PROPERTIES, {
      eventId: 'job:race:3', kind: 'side-job', completed: true,
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.state.properties['arroyo-diner']?.uncollectedPayouts).toBe(3);
  });

  it('keeps the trusted batch helper capped and collections non-repeatable', () => {
    const purchase = purchaseProperty(createEconomyState(2_000), PROPERTY);
    if (!purchase.success) throw new Error(purchase.reason);
    const accrued = accruePropertyPayouts(purchase.state, [PROPERTY], 10);
    expect(accrued.properties[PROPERTY.id]?.uncollectedPayouts).toBe(3);

    const collected = collectPropertyIncome(accrued, [PROPERTY], PROPERTY.id);
    expect(collected.amount).toBe(300);
    expect(collected.state.cash).toBe(1_300);
    const duplicate = collectPropertyIncome(collected.state, [PROPERTY], PROPERTY.id);
    expect(duplicate.amount).toBe(0);
    expect(duplicate.state.cash).toBe(1_300);

    const fullWallet = { ...accrued, cash: Number.MAX_SAFE_INTEGER };
    const rejectedAtCap = collectPropertyIncome(fullWallet, [PROPERTY], PROPERTY.id);
    expect(rejectedAtCap.amount).toBe(0);
    expect(rejectedAtCap.state.properties[PROPERTY.id]?.uncollectedPayouts).toBe(3);
  });

  it('combines club perk, upgrade, and Rule income without double rounding', () => {
    const club = requireProperty('neon-strand-club');
    const state = ownProperties([club.id], true, 3, 0);
    expect(propertyIncomeForPayouts(state, club, 3, 'rule')).toBe(9_315);
    const collected = collectPropertyIncome(state, PROPERTIES, club.id, 'rule');
    expect(collected.amount).toBe(9_315);
    expect(collected.state.cash).toBe(9_315);
    expect(collectPropertyIncome(collected.state, PROPERTIES, club.id, 'rule').amount).toBe(0);
  });

  it('applies Expose to upgraded perks and grants diner recovery stock per payout', () => {
    const diner = requireProperty('arroyo-diner');
    const state = ownProperties([diner.id], true, 2, 0);
    expect(propertyPerkMultiplier(state, diner, 'expose')).toBeCloseTo(1.8);
    const collected = collectPropertyIncome(state, PROPERTIES, diner.id, 'expose');
    expect(collected.amount).toBe(3_150);
    expect(collected.grants).toEqual([{ itemId: 'medkit', quantity: 3 }]);
    expect(propertyPerkMultiplier(createEconomyState(), diner, null)).toBe(0);
  });
});

describe('property service hooks', () => {
  const allIds = PROPERTIES.map((property) => property.id);

  it('resolves registration, repair, healing, search, stash, yield, and reputation perks', () => {
    const state = ownProperties(allIds, true);
    expect(resolvePropertyServiceModifiers(state, PROPERTIES, 'expose')).toEqual({
      vehicleRegistrationDiscountPercent: 27,
      vehicleRepairDiscountPercent: 36,
      foodHealingMultiplier: 1.36,
      wantedSearchDurationMultiplier: 0.82,
      servicedVehicleSearchDurationMultiplier: 0.82,
      stashRowBonus: 3,
      salvageComponentYieldMultiplier: 1.36,
      contactReputationMultiplier: 1.18,
    });
  });

  it('quotes and purchases discounted services once across a shared transaction ledger', () => {
    const state = ownProperties(allIds, true, 0, 2_000);
    expect(quoteServicePrice(state, {
      service: 'vehicle-registration', basePrice: 1_000,
      propertyDefinitions: PROPERTIES, ending: 'expose',
    })).toBe(730);
    expect(quoteServicePrice(state, {
      service: 'vehicle-repair', basePrice: 1_000,
      propertyDefinitions: PROPERTIES, ending: 'expose',
    })).toBe(640);
    expect(quoteServicePrice(state, {
      service: 'clothing', basePrice: 1_000,
      propertyDefinitions: PROPERTIES, ending: 'expose',
    })).toBe(1_000);

    const noOp = purchaseService(state, {
      transactionId: 'service:full-health',
      service: 'clinic-healing',
      basePrice: 250,
      propertyDefinitions: PROPERTIES,
      serviceCanApply: false,
    });
    expect(noOp.success).toBe(false);
    expect(noOp.state.cash).toBe(2_000);

    const purchased = purchaseService(state, {
      transactionId: 'service:registration:1',
      service: 'vehicle-registration',
      basePrice: 1_000,
      propertyDefinitions: PROPERTIES,
      ending: 'expose',
    });
    expect(purchased).toEqual(expect.objectContaining({
      success: true,
      cost: 730,
      effect: { service: 'vehicle-registration', units: 1 },
    }));
    if (!purchased.success) return;
    expect(purchased.state.cash).toBe(1_270);
    const duplicate = purchaseService(purchased.state, {
      transactionId: 'service:registration:1',
      service: 'vehicle-registration', basePrice: 1_000,
      propertyDefinitions: PROPERTIES,
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.state.cash).toBe(1_270);
  });
});

describe('deterministic activity income', () => {
  it('quotes difficulty, Hustle, Side Hustle, and Kingpin from explicit inputs', () => {
    const activity = ACTIVITIES[0]!;
    const first = quoteActivityIncome(activity, 'professional', {
      hustleLevel: 6,
      sideHustle: true,
      kingpin: true,
    });
    const second = quoteActivityIncome(activity, 'professional', {
      hustleLevel: 6,
      sideHustle: true,
      kingpin: true,
    });
    expect(first).toEqual(second);
    expect(first).toEqual({
      activityId: 'street-race',
      difficultyId: 'professional',
      cash: 1_719,
      xp: 192,
      cashMultiplier: 1.653125,
      difficultyMultiplier: 1.6,
    });
  });

  it('awards an activity quote once and leaves XP for the progression commit', () => {
    const quote = quoteActivityIncome(ACTIVITIES[1]!, 'rookie', { hustleLevel: 2 });
    const award = awardActivityIncome(createEconomyState(10), 'activity:courier:001', quote);
    expect(award).toEqual(expect.objectContaining({ success: true, cash: 525, xp: 100 }));
    if (!award.success) return;
    expect(award.state.cash).toBe(535);
    const duplicate = awardActivityIncome(award.state, 'activity:courier:001', quote);
    expect(duplicate.success).toBe(false);
    expect(duplicate.state.cash).toBe(535);
  });
});

describe('economy snapshot restore validation', () => {
  it('round-trips a snapshot without retaining mutable references', () => {
    const source = ownProperties(['arroyo-diner'], true, 2, 1_000);
    source.processedTransactionIds = ['shop:1'];
    source.completedPayoutEventIds = ['mission:1'];
    const snapshot = createEconomySnapshot(source);
    const restored = restoreEconomyState(snapshot, PROPERTIES);
    expect(restored.success).toBe(true);
    if (!restored.success) return;
    expect(restored.state).toEqual({
      cash: 1_000,
      properties: source.properties,
      processedTransactionIds: ['shop:1'],
      completedPayoutEventIds: ['mission:1'],
    });
    restored.state.properties['arroyo-diner']!.uncollectedPayouts = 0;
    expect(snapshot.properties['arroyo-diner']?.uncollectedPayouts).toBe(2);
  });

  it('accepts save-shaped legacy fields with no runtime ledgers', () => {
    const legacy = ownProperties(['arroyo-diner'], false, 0, 20);
    expect(restoreEconomyState(legacy, PROPERTIES)).toEqual({
      success: true,
      state: legacy,
    });

    const fields = createEconomySaveFields(legacy);
    expect(fields).toEqual({ money: 20, properties: legacy.properties });
    const restored = restoreEconomySaveFields(fields, PROPERTIES);
    expect(restored).toEqual({ success: true, state: legacy });
    fields.properties['arroyo-diner']!.owned = false;
    expect(legacy.properties['arroyo-diner']?.owned).toBe(true);
  });

  it('rejects unsafe cash, unknown properties, impossible ownership, caps, and ledgers', () => {
    const invalid = {
      cash: -1,
      properties: {
        unknown: { owned: false, upgraded: true, uncollectedPayouts: 4 },
      },
      processedTransactionIds: ['same', 'same'],
      completedPayoutEventIds: ['__proto__'],
    };
    const validation = validateEconomyState(invalid, PROPERTIES);
    expect(validation.valid).toBe(false);
    if (validation.valid) return;
    expect(validation.errors).toEqual(expect.arrayContaining([
      'cash must be a non-negative safe integer',
      'properties.unknown is not in the property catalog',
      'properties.unknown.uncollectedPayouts must be an integer between 0 and 3',
      'properties.unknown cannot be upgraded while unowned',
      'processedTransactionIds[1] is duplicated',
      'completedPayoutEventIds[0] is invalid',
    ]));
    expect(restoreEconomyState(invalid, PROPERTIES).success).toBe(false);
  });
});
