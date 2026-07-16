import type { EndingChoice } from '../core/state';
import { ITEMS } from '../data/items';
import { PROPERTIES } from '../data/economy';
import type { PropertyDefinition } from '../data/types';
import {
  collectPropertyIncome,
  propertyIncomeForPayouts,
  purchaseProperty,
  purchaseShopItem,
  quoteShopPrice,
  upgradeProperty,
  type EconomyState,
  type ShopMarket,
} from '../systems/economy';
import type { ProgressionState } from '../systems/progression';

export type EconomyPanelAction =
  | { readonly type: 'buy-item'; readonly itemId: string; readonly market: ShopMarket }
  | { readonly type: 'purchase-property'; readonly propertyId: string }
  | { readonly type: 'upgrade-property'; readonly propertyId: string }
  | { readonly type: 'collect-property'; readonly propertyId: string }
  | { readonly type: 'collect-all' };

export interface EconomyPanelActionDataset {
  readonly economyAction?: string;
  readonly itemId?: string;
  readonly market?: string;
  readonly propertyId?: string;
}

export interface EconomyPanelState {
  readonly economy: EconomyState;
  readonly ending: EndingChoice | null;
  readonly progression: ProgressionState;
  readonly inventoryCanAccept?: Readonly<Record<string, boolean>>;
}

export interface ShopItemPanelModel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly market: ShopMarket;
  readonly price: number;
  readonly priceLabel: string;
  readonly available: boolean;
  readonly reason: string | null;
}

export interface PropertyPanelModel {
  readonly id: string;
  readonly name: string;
  readonly district: string;
  readonly description: string;
  readonly purchasePrice: number;
  readonly purchasePriceLabel: string;
  readonly owned: boolean;
  readonly upgraded: boolean;
  readonly upgradeName: string;
  readonly upgradeCost: number;
  readonly upgradeCostLabel: string;
  readonly payouts: number;
  readonly payoutCap: number;
  readonly collectAmount: number;
  readonly collectAmountLabel: string;
  readonly perks: readonly string[];
  readonly purchaseAvailable: boolean;
  readonly purchaseReason: string | null;
  readonly upgradeAvailable: boolean;
  readonly upgradeReason: string | null;
  readonly collectAvailable: boolean;
}

export interface EconomyPanelModel {
  readonly cash: number;
  readonly cashLabel: string;
  readonly legitimateDiscountPercent: number;
  readonly shopItems: readonly ShopItemPanelModel[];
  readonly properties: readonly PropertyPanelModel[];
  readonly totalCollectAmount: number;
  readonly totalCollectAmountLabel: string;
}

const LEGITIMATE_SHOP_IDS = [
  'ammo-handgun',
  'ammo-smg',
  'ammo-shotgun',
  'ammo-rifle',
  'medkit',
  'armor-repair-plate',
  'weapon-repair-kit',
  'vehicle-repair-kit',
  'armor-light',
  'pistol-tier-1',
] as const;
const BLACK_MARKET_SHOP_IDS = [
  'pistol-tier-2',
  'smg-tier-1',
  'shotgun-tier-1',
  'rifle-tier-1',
  'attachment-suppressor',
] as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEGITIMATE_SHOP_ID_SET = new Set<string>(LEGITIMATE_SHOP_IDS);
const BLACK_MARKET_SHOP_ID_SET = new Set<string>(BLACK_MARKET_SHOP_IDS);
const PROPERTY_IDS = new Set<string>(PROPERTIES.map((property) => property.id));

export function createEconomyPanelModel(state: Readonly<EconomyPanelState>): EconomyPanelModel {
  const legitimateDiscountPercent = state.progression.unlockedSkills.includes('streetcraft-silver-tongue') ? 10 : 0;
  const shopItems = [
    ...createShopModels(state, LEGITIMATE_SHOP_IDS, 'legitimate', legitimateDiscountPercent),
    ...createShopModels(state, BLACK_MARKET_SHOP_IDS, 'black-market', legitimateDiscountPercent),
  ];
  const properties = PROPERTIES.map((definition) => createPropertyModel(state, definition));
  const collection = collectPropertyIncome(state.economy, PROPERTIES, 'all', state.ending);
  return {
    cash: state.economy.cash,
    cashLabel: formatCash(state.economy.cash),
    legitimateDiscountPercent,
    shopItems,
    properties,
    totalCollectAmount: collection.amount,
    totalCollectAmountLabel: formatCash(collection.amount),
  };
}

export function renderEconomyPanel(model: Readonly<EconomyPanelModel>): string {
  const legitimate = model.shopItems.filter((item) => item.market === 'legitimate');
  const blackMarket = model.shopItems.filter((item) => item.market === 'black-market');
  return [
    '<section class="economy-panel" data-economy-panel="true" aria-labelledby="economy-panel-title">',
    '<header class="economy-panel__header"><div><p class="eyebrow">Solara economy</p><h2 id="economy-panel-title">Street services & properties</h2><p>Buy supplies anywhere. Property income accrues after completed jobs.</p></div>',
    `<dl><div><dt>Cash</dt><dd data-economy-cash="${model.cash}">${escapeHtml(model.cashLabel)}</dd></div><div><dt>Shop discount</dt><dd>${model.legitimateDiscountPercent}%</dd></div></dl></header>`,
    '<section class="economy-panel__section" aria-labelledby="shops-heading"><div class="economy-panel__section-heading"><div><p class="eyebrow">Street services</p><h3 id="shops-heading">Shops</h3></div><p>Purchases are atomic: cash is charged only when the full item fits.</p></div>',
    '<div class="shop-columns">',
    renderShop('Coastline Supply', 'Legitimate stock · Silver Tongue applies', legitimate),
    renderShop('Breakwater Dealer', 'Specialist stock · ending prices apply', blackMarket),
    '</div></section>',
    '<section class="economy-panel__section" aria-labelledby="properties-heading"><div class="economy-panel__section-heading"><div><p class="eyebrow">Passive network</p><h3 id="properties-heading">Properties</h3></div>',
    `<button type="button" data-economy-action="collect-all"${disabledAttributes(model.totalCollectAmount > 0, 'No property income is ready')}>Collect all · ${escapeHtml(model.totalCollectAmountLabel)}</button></div>`,
    `<div class="property-grid">${model.properties.map(renderProperty).join('')}</div></section>`,
    '</section>',
  ].join('');
}

export function parseEconomyPanelAction(target: EventTarget | null): EconomyPanelAction | null {
  if (!hasClosest(target)) return null;
  const actionTarget = target.closest('[data-economy-action]');
  if (!hasDataset(actionTarget) || actionTarget.disabled === true) return null;
  return parseEconomyPanelActionDataset(actionTarget.dataset);
}

export function parseEconomyPanelActionDataset(
  dataset: Readonly<EconomyPanelActionDataset>,
): EconomyPanelAction | null {
  switch (dataset.economyAction) {
    case 'buy-item':
      if (
        isSafeId(dataset.itemId)
        && isMarket(dataset.market)
        && isStockedInMarket(dataset.itemId, dataset.market)
      ) {
        return { type: 'buy-item', itemId: dataset.itemId, market: dataset.market };
      }
      return null;
    case 'purchase-property':
    case 'upgrade-property':
    case 'collect-property':
      return isSafeId(dataset.propertyId) && PROPERTY_IDS.has(dataset.propertyId)
        ? { type: dataset.economyAction, propertyId: dataset.propertyId }
        : null;
    case 'collect-all':
      return { type: 'collect-all' };
    default:
      return null;
  }
}

export class EconomyPanel {
  readonly #target: HTMLElement;

  public constructor(target: HTMLElement) {
    this.#target = target;
  }

  public draw(state: Readonly<EconomyPanelState>): EconomyPanelModel {
    const model = createEconomyPanelModel(state);
    this.#target.innerHTML = renderEconomyPanel(model);
    return model;
  }
}

function createShopModels(
  state: Readonly<EconomyPanelState>,
  ids: readonly string[],
  market: ShopMarket,
  legitimateDiscountPercent: number,
): ShopItemPanelModel[] {
  return ids.flatMap((id) => {
    const definition = ITEMS.find((item) => item.id === id);
    if (!definition) return [];
    const pricing = { market, legitimateDiscountPercent, ending: state.ending } as const;
    const transaction = purchaseShopItem(state.economy, definition, 1, pricing);
    const inventoryCanAccept = state.inventoryCanAccept?.[id] ?? true;
    const price = quoteShopPrice(definition.baseValue, 1, pricing);
    return [{
      id: definition.id,
      name: definition.name,
      description: definition.description,
      category: definition.category,
      market,
      price,
      priceLabel: formatCash(price),
      available: transaction.success && inventoryCanAccept,
      reason: !inventoryCanAccept
        ? 'Backpack has no valid space or weight capacity'
        : transaction.success ? null : friendlyReason(transaction.reason),
    }];
  });
}

function createPropertyModel(
  state: Readonly<EconomyPanelState>,
  definition: Readonly<PropertyDefinition>,
): PropertyPanelModel {
  const saved = state.economy.properties[definition.id];
  const purchase = purchaseProperty(state.economy, definition);
  const upgrade = upgradeProperty(state.economy, definition);
  const payouts = saved?.uncollectedPayouts ?? 0;
  const collectAmount = propertyIncomeForPayouts(state.economy, definition, payouts, state.ending);
  return {
    id: definition.id,
    name: definition.name,
    district: titleCase(definition.district),
    description: definition.description,
    purchasePrice: definition.purchasePrice,
    purchasePriceLabel: formatCash(definition.purchasePrice),
    owned: saved?.owned ?? false,
    upgraded: saved?.upgraded ?? false,
    upgradeName: definition.upgrade.name,
    upgradeCost: definition.upgrade.cost,
    upgradeCostLabel: formatCash(definition.upgrade.cost),
    payouts,
    payoutCap: definition.payoutCap,
    collectAmount,
    collectAmountLabel: formatCash(collectAmount),
    perks: definition.perks.map((perk) => perk.description),
    purchaseAvailable: purchase.success,
    purchaseReason: purchase.success ? null : friendlyReason(purchase.reason),
    upgradeAvailable: upgrade.success,
    upgradeReason: upgrade.success ? null : friendlyReason(upgrade.reason),
    collectAvailable: collectAmount > 0,
  };
}

function renderShop(title: string, subtitle: string, items: readonly ShopItemPanelModel[]): string {
  return `<article class="shop-card"><header><div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(subtitle)}</p></div><span>${items.length} items</span></header><ul>${items.map((item) => `<li data-shop-item="${escapeHtml(item.id)}"><div><span>${escapeHtml(item.category)}</span><h5>${escapeHtml(item.name)}</h5><p>${escapeHtml(item.description)}</p>${item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ''}</div><button type="button" data-economy-action="buy-item" data-item-id="${escapeHtml(item.id)}" data-market="${item.market}"${disabledAttributes(item.available, item.reason)}>Buy · ${escapeHtml(item.priceLabel)}</button></li>`).join('')}</ul></article>`;
}

function renderProperty(property: Readonly<PropertyPanelModel>): string {
  const stateLabel = property.owned ? property.upgraded ? 'Upgraded' : 'Owned' : 'For sale';
  const reason = property.owned ? property.upgradeReason : property.purchaseReason;
  const primary = property.owned
    ? `<button type="button" data-economy-action="upgrade-property" data-property-id="${escapeHtml(property.id)}"${disabledAttributes(property.upgradeAvailable, reason)}>Upgrade · ${escapeHtml(property.upgradeCostLabel)}</button>`
    : `<button type="button" data-economy-action="purchase-property" data-property-id="${escapeHtml(property.id)}"${disabledAttributes(property.purchaseAvailable, reason)}>Buy · ${escapeHtml(property.purchasePriceLabel)}</button>`;
  return `<article class="property-card ${property.owned ? 'is-owned' : ''}" data-property-id="${escapeHtml(property.id)}">
    <header><div><span>${escapeHtml(property.district)}</span><h4>${escapeHtml(property.name)}</h4></div><b>${stateLabel}</b></header>
    <p>${escapeHtml(property.description)}</p>
    <ul>${property.perks.map((perk) => `<li>${escapeHtml(perk)}</li>`).join('')}</ul>
    <div class="property-card__payout"><span>Payouts ${property.payouts} / ${property.payoutCap}</span><strong>${escapeHtml(property.collectAmountLabel)}</strong></div>
    <footer>${primary}<button type="button" data-economy-action="collect-property" data-property-id="${escapeHtml(property.id)}"${disabledAttributes(property.collectAvailable, 'No income is ready')}>Collect</button></footer>
    <small>${escapeHtml(reason ?? `${property.upgradeName} raises payout and perk strength by 50%.`)}</small>
  </article>`;
}

function formatCash(value: number): string {
  return `$${Math.max(0, Math.floor(value)).toLocaleString('en-US')}`;
}

function disabledAttributes(available: boolean, reason: string | null): string {
  if (available) return '';
  return ` disabled aria-disabled="true"${reason ? ` title="${escapeHtml(reason)}"` : ''}`;
}

function friendlyReason(reason: string): string {
  if (reason === 'not enough cash') return 'Not enough cash';
  if (reason.includes('already owned')) return 'Already owned';
  if (reason.includes('already upgraded')) return 'Upgrade installed';
  if (reason.includes('must be owned')) return 'Purchase the property first';
  return reason;
}

function titleCase(value: string): string {
  return value.split('-').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');
}

function isSafeId(value: string | undefined): value is string {
  return value !== undefined && SAFE_ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function isMarket(value: string | undefined): value is ShopMarket {
  return value === 'legitimate' || value === 'black-market';
}

function isStockedInMarket(itemId: string, market: ShopMarket): boolean {
  return market === 'legitimate'
    ? LEGITIMATE_SHOP_ID_SET.has(itemId)
    : BLACK_MARKET_SHOP_ID_SET.has(itemId);
}

function hasClosest(value: unknown): value is { closest(selector: string): unknown } {
  return typeof value === 'object' && value !== null && 'closest' in value && typeof value.closest === 'function';
}

function hasDataset(value: unknown): value is { dataset: EconomyPanelActionDataset; disabled?: boolean } {
  return typeof value === 'object' && value !== null && 'dataset' in value && typeof value.dataset === 'object' && value.dataset !== null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
