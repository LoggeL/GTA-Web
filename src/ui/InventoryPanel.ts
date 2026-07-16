import type { SavedInventory, SavedItemInstance } from '../core/state';
import { ITEMS, RECIPES, WEAPONS } from '../data/items';
import type { ItemDefinition } from '../data/types';
import {
  BACKPACK_GRID_HEIGHT,
  BACKPACK_GRID_WIDTH,
  durabilityCondition,
  inventoryWeight,
  isItemUsable,
} from '../systems/inventory';
import {
  previewCraft,
  type CraftPreview,
} from '../systems/crafting';
import type {
  QuickLoadoutSlot,
  TacticalContainerRef,
  TacticalInventoryState,
} from '../systems/tacticalInventory';

export type InventoryPanelAction =
  | { readonly type: 'select'; readonly instanceId: string }
  | { readonly type: 'move'; readonly x: number; readonly y: number }
  | { readonly type: 'rotate' }
  | { readonly type: 'split' }
  | { readonly type: 'auto-sort'; readonly container: TacticalContainerRef }
  | { readonly type: 'transfer'; readonly destination: TacticalContainerRef }
  | { readonly type: 'transfer-all'; readonly source: TacticalContainerRef; readonly destination: TacticalContainerRef }
  | { readonly type: 'assign-loadout'; readonly slot: QuickLoadoutSlot }
  | { readonly type: 'clear-loadout'; readonly slot: QuickLoadoutSlot }
  | { readonly type: 'use' }
  | { readonly type: 'repair' }
  | { readonly type: 'craft'; readonly recipeId: string };

export interface InventoryPanelActionDataset {
  readonly inventoryAction?: string;
  readonly instanceId?: string;
  readonly inventoryX?: string;
  readonly inventoryY?: string;
  readonly containerKind?: string;
  readonly vehicleInstanceId?: string;
  readonly sourceKind?: string;
  readonly sourceVehicleInstanceId?: string;
  readonly destinationKind?: string;
  readonly destinationVehicleInstanceId?: string;
  readonly loadoutSlot?: string;
  readonly recipeId?: string;
}

export interface InventoryPanelState {
  readonly tactical: TacticalInventoryState;
  readonly selectedInstanceId: string | null;
  readonly safehouseBench: boolean;
  readonly activeTrunkId: string | null;
}

export interface InventoryItemPanelModel {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly quantity: number;
  readonly durability: number;
  readonly condition: string;
  readonly usable: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotated: boolean;
  readonly selected: boolean;
  readonly container: TacticalContainerRef;
}

export interface LoadoutSlotPanelModel {
  readonly slot: QuickLoadoutSlot;
  readonly label: string;
  readonly instanceId: string | null;
  readonly itemName: string;
}

export interface RecipePanelModel extends CraftPreview {
  readonly name: string;
  readonly outputName: string;
  readonly ingredientLabel: string;
}

export interface InventoryPanelModel {
  readonly backpack: SavedInventory;
  readonly backpackItems: readonly InventoryItemPanelModel[];
  readonly stashItems: readonly InventoryItemPanelModel[];
  readonly trunkItems: readonly InventoryItemPanelModel[];
  readonly activeTrunkId: string | null;
  readonly selected: InventoryItemPanelModel | null;
  readonly weight: number;
  readonly weightLabel: string;
  readonly weightPercent: number;
  readonly loadout: readonly LoadoutSlotPanelModel[];
  readonly recipes: readonly RecipePanelModel[];
  readonly safehouseBench: boolean;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GRID_COORDINATE = /^(?:0|[1-9]\d*)$/;
const RECIPE_IDS = new Set(RECIPES.map((recipe) => recipe.id));
const LOADOUT_SLOTS: readonly QuickLoadoutSlot[] = [
  'firearm-1', 'firearm-2', 'melee', 'consumable-1', 'consumable-2',
];

export function createInventoryPanelModel(state: Readonly<InventoryPanelState>): InventoryPanelModel {
  const activeTrunk = state.activeTrunkId && Object.hasOwn(state.tactical.trunks, state.activeTrunkId)
    ? state.tactical.trunks[state.activeTrunkId]
    : undefined;
  const activeTrunkId = activeTrunk ? state.activeTrunkId : null;
  const backpackItems = itemModels(
    state.tactical.backpack.items,
    { kind: 'backpack' },
    state.selectedInstanceId,
  );
  const stashItems = itemModels(state.tactical.stash, { kind: 'stash' }, state.selectedInstanceId);
  const trunkItems = activeTrunk
    ? itemModels(activeTrunk.items, { kind: 'trunk', vehicleInstanceId: activeTrunkId! }, state.selectedInstanceId)
    : [];
  const allItems = [...backpackItems, ...stashItems, ...trunkItems];
  const selected = allItems.find((item) => item.selected) ?? null;
  const weight = inventoryWeight(state.tactical.backpack, ITEMS);
  const loadoutIds: readonly [QuickLoadoutSlot, string | null][] = [
    ['firearm-1', state.tactical.quickLoadout.firearms[0]],
    ['firearm-2', state.tactical.quickLoadout.firearms[1]],
    ['melee', state.tactical.quickLoadout.melee],
    ['consumable-1', state.tactical.quickLoadout.consumables[0]],
    ['consumable-2', state.tactical.quickLoadout.consumables[1]],
  ];
  const loadout = loadoutIds.map(([slot, instanceId]): LoadoutSlotPanelModel => ({
    slot,
    label: loadoutLabel(slot),
    instanceId,
    itemName: itemNameForInstance(instanceId, state.tactical.backpack.items),
  }));
  const bench = state.safehouseBench ? 'safehouse' : 'field';
  const recipes = RECIPES.map((recipe): RecipePanelModel => {
    const preview = previewCraft(
      state.tactical.backpack,
      ITEMS,
      RECIPES,
      state.tactical.recipeUnlocks,
      recipe.id,
      bench,
    );
    return {
      ...preview,
      name: recipe.name,
      outputName: itemName(recipe.output.itemId),
      ingredientLabel: recipe.ingredients
        .map((ingredient) => `${ingredient.quantity}× ${itemName(ingredient.itemId)}`)
        .join(' · '),
    };
  });
  return {
    backpack: cloneInventory(state.tactical.backpack),
    backpackItems,
    stashItems,
    trunkItems,
    activeTrunkId,
    selected,
    weight,
    weightLabel: `${formatWeight(weight)} / ${formatWeight(state.tactical.backpack.maxWeightKg)} kg`,
    weightPercent: Math.min(100, Math.round(weight / Math.max(0.001, state.tactical.backpack.maxWeightKg) * 100)),
    loadout,
    recipes,
    safehouseBench: state.safehouseBench,
  };
}

export function renderInventoryPanel(model: Readonly<InventoryPanelModel>): string {
  return [
    '<section class="tactical-inventory" data-inventory-panel="true" aria-labelledby="inventory-panel-title">',
    '<header class="tactical-inventory__header"><div><p class="eyebrow">Tactical inventory</p><h2 id="inventory-panel-title">Backpack & loadout</h2><p>Select an item, then tap a grid cell or use the contextual actions.</p></div>',
    `<div class="inventory-weight"><span>${escapeHtml(model.weightLabel)}</span><div role="progressbar" aria-label="Backpack weight ${escapeHtml(model.weightLabel)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${model.weightPercent}"><i style="--weight-progress:${model.weightPercent}%"></i></div></div></header>`,
    '<section class="loadout-strip" aria-label="Quick loadout">',
    ...model.loadout.map((slot) => `<article data-loadout-slot="${slot.slot}"><span>${escapeHtml(slot.label)}</span><strong>${escapeHtml(slot.itemName)}</strong>${slot.instanceId ? `<button type="button" data-inventory-action="clear-loadout" data-loadout-slot="${slot.slot}" aria-label="Clear ${escapeHtml(slot.label)}">×</button>` : ''}</article>`),
    '</section>',
    '<div class="tactical-inventory__workspace">',
    '<section class="inventory-container inventory-container--backpack" aria-labelledby="backpack-heading"><header><div><h3 id="backpack-heading">Backpack</h3><p>8 × 6 shaped grid</p></div><button type="button" data-inventory-action="auto-sort" data-container-kind="backpack">Auto-sort</button></header>',
    renderGrid(model),
    '</section>',
    renderDetails(model),
    '</div>',
    '<div class="storage-columns">',
    renderStorageList('Safehouse stash', 'Unlimited abstract storage', model.stashItems, { kind: 'stash' }, model.selected),
    model.activeTrunkId
      ? renderStorageList('Vehicle trunk', model.activeTrunkId, model.trunkItems, { kind: 'trunk', vehicleInstanceId: model.activeTrunkId }, model.selected)
      : '<section class="storage-list is-unavailable"><header><div><h3>Vehicle trunk</h3><p>Enter an owned vehicle to access its trunk.</p></div></header></section>',
    '</div>',
    renderCrafting(model),
    '</section>',
  ].join('');
}

export function parseInventoryPanelAction(target: EventTarget | null): InventoryPanelAction | null {
  if (!hasClosest(target)) return null;
  const actionTarget = target.closest('[data-inventory-action]');
  if (!hasDataset(actionTarget) || actionTarget.disabled === true) return null;
  return parseInventoryPanelActionDataset(actionTarget.dataset);
}

export function parseInventoryPanelActionDataset(
  dataset: Readonly<InventoryPanelActionDataset>,
): InventoryPanelAction | null {
  switch (dataset.inventoryAction) {
    case 'select':
      return isSafeId(dataset.instanceId) ? { type: 'select', instanceId: dataset.instanceId } : null;
    case 'move': {
      const x = parseGridCoordinate(dataset.inventoryX, BACKPACK_GRID_WIDTH);
      const y = parseGridCoordinate(dataset.inventoryY, BACKPACK_GRID_HEIGHT);
      return x !== null && y !== null
        ? { type: 'move', x, y }
        : null;
    }
    case 'rotate': return { type: 'rotate' };
    case 'split': return { type: 'split' };
    case 'use': return { type: 'use' };
    case 'repair': return { type: 'repair' };
    case 'auto-sort': {
      const container = parseContainer(dataset.containerKind, dataset.vehicleInstanceId);
      return container ? { type: 'auto-sort', container } : null;
    }
    case 'transfer': {
      const destination = parseContainer(dataset.destinationKind, dataset.destinationVehicleInstanceId);
      return destination ? { type: 'transfer', destination } : null;
    }
    case 'transfer-all': {
      const source = parseContainer(dataset.sourceKind, dataset.sourceVehicleInstanceId);
      const destination = parseContainer(dataset.destinationKind, dataset.destinationVehicleInstanceId);
      return source && destination ? { type: 'transfer-all', source, destination } : null;
    }
    case 'assign-loadout':
      return isLoadoutSlot(dataset.loadoutSlot) ? { type: 'assign-loadout', slot: dataset.loadoutSlot } : null;
    case 'clear-loadout':
      return isLoadoutSlot(dataset.loadoutSlot) ? { type: 'clear-loadout', slot: dataset.loadoutSlot } : null;
    case 'craft':
      return isSafeId(dataset.recipeId) && RECIPE_IDS.has(dataset.recipeId)
        ? { type: 'craft', recipeId: dataset.recipeId }
        : null;
    default:
      return null;
  }
}

export class InventoryPanel {
  readonly #target: HTMLElement;

  public constructor(target: HTMLElement) {
    this.#target = target;
  }

  public draw(state: Readonly<InventoryPanelState>): InventoryPanelModel {
    const model = createInventoryPanelModel(state);
    this.#target.innerHTML = renderInventoryPanel(model);
    return model;
  }
}

function renderGrid(model: Readonly<InventoryPanelModel>): string {
  const canMoveSelected = model.selected?.container.kind === 'backpack';
  const cells = Array.from({ length: model.backpack.gridWidth * model.backpack.gridHeight }, (_, index) => {
    const x = index % model.backpack.gridWidth;
    const y = Math.floor(index / model.backpack.gridWidth);
    return `<button type="button" class="inventory-cell" data-inventory-action="move" data-inventory-x="${x}" data-inventory-y="${y}" aria-label="Move selected item to column ${x + 1}, row ${y + 1}"${disabledAttributes(canMoveSelected, 'Select a carried backpack item first')}></button>`;
  }).join('');
  const items = model.backpackItems.map((item) => `<button type="button" draggable="true" class="inventory-item inventory-item--${escapeHtml(item.category)} ${item.selected ? 'is-selected' : ''}" data-inventory-action="select" data-instance-id="${escapeHtml(item.instanceId)}" style="--item-x:${item.x + 1};--item-y:${item.y + 1};--item-width:${item.width};--item-height:${item.height}" aria-label="${escapeHtml(item.name)}, quantity ${item.quantity}, ${Math.round(item.durability)} durability" aria-pressed="${item.selected}"><span>${escapeHtml(abbreviate(item.name))}</span>${item.quantity > 1 ? `<b>${item.quantity}</b>` : ''}${item.durability < 100 ? `<i style="--durability:${Math.round(item.durability)}%"></i>` : ''}</button>`).join('');
  return `<div class="inventory-grid inventory-grid--interactive" style="--grid-width:${model.backpack.gridWidth};--grid-height:${model.backpack.gridHeight}" data-inventory-grid>${cells}${items}</div>`;
}

function renderDetails(model: Readonly<InventoryPanelModel>): string {
  const item = model.selected;
  if (!item) {
    return '<aside class="inventory-details"><p class="eyebrow">Selection</p><h3>No item selected</h3><p>Select a carried or stored item to inspect, equip, move, split, use, or repair it.</p></aside>';
  }
  const definition = ITEMS.find((entry) => entry.id === item.definitionId);
  const carried = item.container.kind === 'backpack';
  const storedItemReason = 'Move this item to the backpack first';
  const loadoutButtons = definition ? compatibleLoadoutSlots(definition).map((slot) => `<button type="button" data-inventory-action="assign-loadout" data-loadout-slot="${slot}"${disabledAttributes(carried, storedItemReason)}>Equip ${escapeHtml(loadoutLabel(slot))}</button>`).join('') : '';
  const transferButtons = transferDestinations(item.container, model.activeTrunkId).map(({ label, destination }) => `<button type="button" data-inventory-action="transfer" data-destination-kind="${destination.kind}" ${destination.kind === 'trunk' ? `data-destination-vehicle-instance-id="${escapeHtml(destination.vehicleInstanceId)}"` : ''}>${escapeHtml(label)}</button>`).join('');
  return `<aside class="inventory-details" data-selected-instance="${escapeHtml(item.instanceId)}">
    <p class="eyebrow">${escapeHtml(item.category)} · ${escapeHtml(containerLabel(item.container))}</p><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description)}</p>
    <dl><div><dt>Quantity</dt><dd>${item.quantity}</dd></div><div><dt>Condition</dt><dd>${escapeHtml(item.condition)}</dd></div><div><dt>Shape</dt><dd>${item.width} × ${item.height}</dd></div></dl>
    <div class="inventory-details__actions"><button type="button" data-inventory-action="rotate"${disabledAttributes(carried, storedItemReason)}>Rotate</button><button type="button" data-inventory-action="split"${disabledAttributes(carried && item.quantity > 1, carried ? 'Stack has only one item' : storedItemReason)}>Split stack</button>${item.category === 'consumable' ? `<button type="button" data-inventory-action="use"${disabledAttributes(carried && item.usable, carried ? 'Item cannot be used' : storedItemReason)}>Use</button>` : ''}${definition?.hasDurability ? `<button type="button" data-inventory-action="repair"${disabledAttributes(carried, storedItemReason)}>Repair</button>` : ''}${loadoutButtons}${transferButtons}</div>
  </aside>`;
}

function renderStorageList(
  title: string,
  subtitle: string,
  items: readonly InventoryItemPanelModel[],
  container: TacticalContainerRef,
  selected: InventoryItemPanelModel | null,
): string {
  const containerAttributes = container.kind === 'trunk'
    ? `data-container-kind="trunk" data-vehicle-instance-id="${escapeHtml(container.vehicleInstanceId)}"`
    : `data-container-kind="${container.kind}"`;
  const sourceAttributes = container.kind === 'trunk'
    ? `data-source-kind="trunk" data-source-vehicle-instance-id="${escapeHtml(container.vehicleInstanceId)}"`
    : `data-source-kind="${container.kind}"`;
  const destination = container.kind === 'backpack' ? 'stash' : 'backpack';
  return `<section class="storage-list" ${containerAttributes}><header><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div><div><button type="button" data-inventory-action="auto-sort" ${containerAttributes}>Sort</button><button type="button" data-inventory-action="transfer-all" ${sourceAttributes} data-destination-kind="${destination}">Move all</button></div></header><ul>${items.length === 0 ? '<li class="is-empty">Empty</li>' : items.map((item) => `<li><button type="button" data-inventory-action="select" data-instance-id="${escapeHtml(item.instanceId)}" class="${item.selected ? 'is-selected' : ''}" aria-pressed="${item.selected}"><span>${escapeHtml(item.name)}</span><b>${item.quantity > 1 ? `×${item.quantity}` : escapeHtml(item.condition)}</b></button></li>`).join('')}</ul>${selected?.container.kind === container.kind ? '<small>Selected item is shown in the detail panel above.</small>' : ''}</section>`;
}

function renderCrafting(model: Readonly<InventoryPanelModel>): string {
  return `<section class="crafting-panel" aria-labelledby="crafting-heading"><header><div><p class="eyebrow">Utility bench</p><h3 id="crafting-heading">Crafting</h3></div><span class="${model.safehouseBench ? 'is-online' : ''}">${model.safehouseBench ? 'Safehouse bench online' : 'Visit Moreno Garage'}</span></header><div class="recipe-grid">${model.recipes.map((recipe) => `<article class="recipe-card ${recipe.craftable ? 'is-craftable' : ''}" data-recipe-id="${escapeHtml(recipe.recipeId)}"><span>${recipe.craftSeconds}s</span><h4>${escapeHtml(recipe.name)}</h4><p>${escapeHtml(recipe.ingredientLabel)}</p><strong>Creates ${escapeHtml(recipe.outputName)}${recipe.output && recipe.output.quantity > 1 ? ` ×${recipe.output.quantity}` : ''}</strong><small>${escapeHtml(recipe.reason ?? 'Components ready')}</small><button type="button" data-inventory-action="craft" data-recipe-id="${escapeHtml(recipe.recipeId)}"${disabledAttributes(recipe.craftable, recipe.reason ?? 'Recipe unavailable')}>Craft</button></article>`).join('')}</div></section>`;
}

function itemModels(
  items: readonly SavedItemInstance[],
  container: TacticalContainerRef,
  selectedInstanceId: string | null,
): InventoryItemPanelModel[] {
  return items.flatMap((item) => {
    const definition = ITEMS.find((candidate) => candidate.id === item.definitionId);
    if (!definition) return [];
    const width = item.rotated ? definition.shape.height : definition.shape.width;
    const height = item.rotated ? definition.shape.width : definition.shape.height;
    return [{
      instanceId: item.instanceId,
      definitionId: item.definitionId,
      name: definition.name,
      description: definition.description,
      category: definition.category,
      quantity: item.quantity,
      durability: item.durability,
      condition: definition.hasDurability ? `${durabilityCondition(item)} · ${Math.round(item.durability)}%` : 'ready',
      usable: isItemUsable(item, definition),
      x: item.x,
      y: item.y,
      width,
      height,
      rotated: item.rotated,
      selected: item.instanceId === selectedInstanceId,
      container,
    }];
  });
}

function compatibleLoadoutSlots(definition: Readonly<ItemDefinition>): readonly QuickLoadoutSlot[] {
  if (definition.category === 'consumable') return ['consumable-1', 'consumable-2'];
  if (definition.category !== 'weapon' || !definition.weaponId) return [];
  const weapon = WEAPONS.find((candidate) => candidate.id === definition.weaponId);
  return weapon?.classId === 'melee' ? ['melee'] : ['firearm-1', 'firearm-2'];
}

function transferDestinations(source: TacticalContainerRef, activeTrunkId: string | null): readonly { label: string; destination: TacticalContainerRef }[] {
  const destinations: { label: string; destination: TacticalContainerRef }[] = [];
  if (source.kind !== 'backpack') destinations.push({ label: 'Move to backpack', destination: { kind: 'backpack' } });
  if (source.kind !== 'stash') destinations.push({ label: 'Move to stash', destination: { kind: 'stash' } });
  if (activeTrunkId && !(source.kind === 'trunk' && source.vehicleInstanceId === activeTrunkId)) {
    destinations.push({ label: 'Move to trunk', destination: { kind: 'trunk', vehicleInstanceId: activeTrunkId } });
  }
  return destinations;
}

function parseContainer(kind: string | undefined, vehicleInstanceId: string | undefined): TacticalContainerRef | null {
  if (kind === 'backpack' || kind === 'stash') return { kind };
  if (kind === 'trunk' && isSafeId(vehicleInstanceId)) return { kind, vehicleInstanceId };
  return null;
}

function parseGridCoordinate(value: string | undefined, upperBound: number): number | null {
  if (!value || !GRID_COORDINATE.test(value)) return null;
  const coordinate = Number(value);
  return Number.isSafeInteger(coordinate) && coordinate < upperBound ? coordinate : null;
}

function isLoadoutSlot(value: string | undefined): value is QuickLoadoutSlot {
  return LOADOUT_SLOTS.includes(value as QuickLoadoutSlot);
}

function itemNameForInstance(instanceId: string | null, items: readonly SavedItemInstance[]): string {
  if (!instanceId) return 'Empty';
  const item = items.find((candidate) => candidate.instanceId === instanceId);
  return item ? itemName(item.definitionId) : 'Missing';
}

function itemName(definitionId: string): string {
  return ITEMS.find((definition) => definition.id === definitionId)?.name ?? definitionId;
}

function loadoutLabel(slot: QuickLoadoutSlot): string {
  return ({
    'firearm-1': 'Firearm 1',
    'firearm-2': 'Firearm 2',
    melee: 'Melee',
    'consumable-1': 'Utility 1',
    'consumable-2': 'Utility 2',
  } as const)[slot];
}

function containerLabel(container: TacticalContainerRef): string {
  return container.kind === 'trunk' ? 'vehicle trunk' : container.kind;
}

function abbreviate(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  return words.length === 1 ? words[0]!.slice(0, 7).toUpperCase() : words.map((word) => word[0]).join('').slice(0, 5).toUpperCase();
}

function formatWeight(value: number): string {
  return Number(value.toFixed(1)).toLocaleString('en-US');
}

function disabledAttributes(enabled: boolean, reason: string): string {
  return enabled
    ? ''
    : ` disabled aria-disabled="true" title="${escapeHtml(reason)}"`;
}

function cloneInventory(inventory: Readonly<SavedInventory>): SavedInventory {
  return { ...inventory, items: inventory.items.map((item) => ({ ...item })) };
}

function isSafeId(value: string | undefined): value is string {
  return value !== undefined && SAFE_ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function hasClosest(value: unknown): value is { closest(selector: string): unknown } {
  return typeof value === 'object' && value !== null && 'closest' in value && typeof value.closest === 'function';
}

function hasDataset(value: unknown): value is { dataset: InventoryPanelActionDataset; disabled?: boolean } {
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
