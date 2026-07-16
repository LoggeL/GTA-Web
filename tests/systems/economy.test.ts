import { describe, expect, it } from 'vitest';

import type { ItemDefinition, PropertyDefinition } from '../../src/data/types';
import {
  accruePropertyPayouts,
  collectPropertyIncome,
  createEconomyState,
  earnCash,
  propertyPerkMultiplier,
  purchaseProperty,
  purchaseShopItem,
  quoteShopPrice,
  spendCash,
  upgradeProperty,
} from '../../src/systems/economy';

const ITEM: ItemDefinition = {
  id: 'medkit', name: 'Medkit', description: '', category: 'consumable',
  shape: { width: 1, height: 1 }, weightKg: 1, maximumStack: 3,
  baseValue: 100, hasDurability: false, discardable: true,
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

describe('economy and properties', () => {
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
  });

  it('quotes legitimate discounts and ending-specific black-market prices', () => {
    expect(quoteShopPrice(100, 2, {
      market: 'legitimate', legitimateDiscountPercent: 10,
    })).toBe(180);
    expect(quoteShopPrice(100, 2, { market: 'black-market', ending: 'rule' })).toBe(180);
    expect(quoteShopPrice(100, 2, { market: 'black-market', ending: 'expose' })).toBe(220);
  });

  it('purchases shop items only when the full price is available', () => {
    const purchased = purchaseShopItem(
      createEconomyState(500),
      ITEM,
      3,
      { market: 'legitimate' },
    );
    expect(purchased.success).toBe(true);
    if (purchased.success) {
      expect(purchased.state.cash).toBe(200);
      expect(purchased.grant).toEqual({ itemId: 'medkit', quantity: 3 });
    }
    expect(purchaseShopItem(
      createEconomyState(50), ITEM, 1, { market: 'legitimate' },
    ).success).toBe(false);
  });

  it('purchases and upgrades a property exactly once', () => {
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
    expect(upgradeProperty(upgrade.state, PROPERTY).success).toBe(false);
  });

  it('caps accrual at three jobs and prevents duplicate collection', () => {
    const purchase = purchaseProperty(createEconomyState(2_000), PROPERTY);
    if (!purchase.success) throw new Error(purchase.reason);
    const accrued = accruePropertyPayouts(purchase.state, [PROPERTY], 10);

    expect(accrued.properties[PROPERTY.id]?.uncollectedPayouts).toBe(3);
    const collected = collectPropertyIncome(accrued, [PROPERTY], PROPERTY.id);
    expect(collected.amount).toBe(300);
    expect(collected.state.cash).toBe(1_300);
    expect(collectPropertyIncome(collected.state, [PROPERTY], PROPERTY.id).amount).toBe(0);
  });

  it('applies upgrade and ending modifiers to income and perks', () => {
    const purchase = purchaseProperty(createEconomyState(2_000), PROPERTY);
    if (!purchase.success) throw new Error(purchase.reason);
    const upgraded = upgradeProperty(purchase.state, PROPERTY);
    if (!upgraded.success) throw new Error(upgraded.reason);
    const accrued = accruePropertyPayouts(upgraded.state, [PROPERTY], 2);
    const collected = collectPropertyIncome(accrued, [PROPERTY], 'all', 'rule');

    expect(collected.amount).toBe(360);
    expect(propertyPerkMultiplier(accrued, PROPERTY, 'expose')).toBeCloseTo(1.8);
    expect(propertyPerkMultiplier(createEconomyState(), PROPERTY, null)).toBe(0);
  });
});
