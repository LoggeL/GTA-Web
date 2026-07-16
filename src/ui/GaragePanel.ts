import type { SavedVehicle } from '../core/state';
import type { VehicleDefinition } from '../data/types';
import { VEHICLES } from '../data/vehicles';
import {
  GARAGE_PAINTS,
  GARAGE_SLOT_COUNT,
  quoteRegistrationFee,
  quoteVehiclePaint,
  quoteVehicleRepair,
  quoteVehicleUpgrade,
  vehicleOperatingState,
} from '../systems/garage';
import type {
  GaragePaint,
  GarageState,
  VehicleOperatingState,
  VehicleUpgradeKind,
  VehicleUpgradeTier,
} from '../systems/garage';

export interface NearbyUnregisteredVehicle {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly registrationDiscountPercent?: number;
}

export type GaragePanelAction =
  | {
    readonly type: 'register';
    readonly vehicleInstanceId: string;
    readonly vehicleDefinitionId: string;
  }
  | {
    readonly type: 'upgrade';
    readonly vehicleInstanceId: string;
    readonly upgrade: VehicleUpgradeKind;
    readonly targetTier: VehicleUpgradeTier;
  }
  | {
    readonly type: 'repair-all';
    readonly vehicleInstanceId: string;
  }
  | {
    readonly type: 'paint';
    readonly vehicleInstanceId: string;
    readonly paint: GaragePaint;
  }
  | {
    readonly type: 'retrieve';
    readonly vehicleInstanceId: string;
  };

export interface GarageActionDataset {
  readonly garageAction?: string;
  readonly vehicleInstanceId?: string;
  readonly vehicleDefinitionId?: string;
  readonly upgradeKind?: string;
  readonly targetTier?: string;
  readonly paintId?: string;
}

export interface GarageActionAvailability {
  readonly enabled: boolean;
  readonly reason: string | null;
}

export interface GarageUpgradeButtonModel extends GarageActionAvailability {
  readonly kind: VehicleUpgradeKind;
  readonly label: string;
  readonly currentTier: number;
  readonly targetTier: VehicleUpgradeTier | null;
  readonly cost: number;
  readonly costLabel: string;
}

export interface GaragePaintButtonModel extends GarageActionAvailability {
  readonly id: GaragePaint;
  readonly label: string;
  readonly selected: boolean;
  readonly cost: number;
  readonly costLabel: string;
}

export interface GarageVehiclePanelModel {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly name: string;
  readonly garageSlot: number;
  readonly slotLabel: string;
  readonly active: boolean;
  readonly retrieve: GarageActionAvailability;
  readonly bodyHealth: number;
  readonly engineHealth: number;
  readonly tireHealthAverage: number;
  readonly operatingState: VehicleOperatingState;
  readonly operatingStateLabel: string;
  readonly trunkColumns: number;
  readonly trunkRows: number;
  readonly trunkItemQuantity: number;
  readonly upgrades: readonly GarageUpgradeButtonModel[];
  readonly repairCost: number;
  readonly repairCostLabel: string;
  readonly repair: GarageActionAvailability;
  readonly paints: readonly GaragePaintButtonModel[];
}

export interface GarageCandidatePanelModel extends GarageActionAvailability {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly name: string;
  readonly registerable: boolean;
  readonly registrationCost: number;
  readonly registrationCostLabel: string;
}

export interface GaragePanelModel {
  readonly cash: number;
  readonly cashLabel: string;
  readonly occupiedSlots: number;
  readonly maximumSlots: typeof GARAGE_SLOT_COUNT;
  readonly availableSlots: number;
  readonly slotSummary: string;
  readonly vehicles: readonly GarageVehiclePanelModel[];
  readonly candidate: GarageCandidatePanelModel | null;
}

export interface GaragePanelOptions {
  readonly vehicleDefinitions?: readonly VehicleDefinition[];
}

const UPGRADE_KINDS = ['engine', 'brakes', 'grip', 'armor'] as const;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_ACTION_IDS = new Set(['__proto__', 'prototype', 'constructor']);

const UPGRADE_LABELS: Readonly<Record<VehicleUpgradeKind, string>> = {
  engine: 'Engine',
  brakes: 'Brakes',
  grip: 'Grip',
  armor: 'Armor',
};

const PAINT_LABELS: Readonly<Record<GaragePaint, string>> = {
  factory: 'Factory finish',
  'coastal-teal': 'Coastal teal',
  'sunset-orange': 'Sunset orange',
  'midnight-indigo': 'Midnight indigo',
};

export function createGaragePanelModel(
  state: Readonly<GarageState>,
  candidate: Readonly<NearbyUnregisteredVehicle> | null = null,
  vehicleDefinitions: readonly VehicleDefinition[] = VEHICLES,
): GaragePanelModel {
  const definitions = new Map<string, VehicleDefinition>(
    vehicleDefinitions.map((definition) => [definition.id, definition]),
  );
  const vehicles = [...state.ownedVehicles]
    .sort(compareVehicles)
    .map((vehicle) => createVehicleModel(state, vehicle, definitions.get(vehicle.definitionId)));
  const occupiedSlots = vehicles.length;
  const availableSlots = Math.max(0, GARAGE_SLOT_COUNT - occupiedSlots);
  return {
    cash: state.cash,
    cashLabel: formatGarageCash(state.cash),
    occupiedSlots,
    maximumSlots: GARAGE_SLOT_COUNT,
    availableSlots,
    slotSummary: `${occupiedSlots} of ${GARAGE_SLOT_COUNT} garage slots occupied`,
    vehicles,
    candidate: candidate
      ? createCandidateModel(state, candidate, definitions.get(candidate.definitionId))
      : null,
  };
}

export function renderGaragePanel(model: Readonly<GaragePanelModel>): string {
  const parts = [
    '<section class="garage-panel" data-garage-panel="true" aria-labelledby="garage-panel-title">',
    '<header class="garage-panel__header">',
    '<div>',
    '<p class="garage-panel__eyebrow">Moreno Garage</p>',
    '<h2 id="garage-panel-title">Vehicle ownership and service</h2>',
    '</div>',
    `<dl class="garage-panel__summary" aria-label="Garage summary"><div><dt>Cash</dt><dd data-garage-cash="${model.cash}">${escapeHtml(model.cashLabel)}</dd></div><div><dt>Storage</dt><dd data-garage-slots="${model.occupiedSlots}/${model.maximumSlots}">${escapeHtml(model.slotSummary)}</dd></div></dl>`,
    '</header>',
    renderCandidate(model.candidate),
    '<section class="garage-panel__owned" aria-labelledby="garage-owned-title">',
    '<h3 id="garage-owned-title">Owned vehicles</h3>',
  ];

  if (model.vehicles.length === 0) {
    parts.push('<p data-garage-empty="true">No registered vehicles. Bring an eligible civilian vehicle to Moreno Garage.</p>');
  } else {
    parts.push('<ol class="garage-panel__vehicle-list">');
    for (const vehicle of model.vehicles) {
      parts.push(`<li>${renderVehicle(vehicle)}</li>`);
    }
    parts.push('</ol>');
  }
  parts.push('</section>', '</section>');
  return parts.join('');
}

export function parseGarageActionDataset(
  dataset: Readonly<GarageActionDataset>,
): GaragePanelAction | null {
  const action = dataset.garageAction;
  const vehicleInstanceId = dataset.vehicleInstanceId;
  if (!isSafeActionId(vehicleInstanceId)) {
    return null;
  }
  switch (action) {
    case 'register': {
      const vehicleDefinitionId = dataset.vehicleDefinitionId;
      return isSafeActionId(vehicleDefinitionId)
        ? { type: 'register', vehicleInstanceId, vehicleDefinitionId }
        : null;
    }
    case 'upgrade': {
      const upgrade = dataset.upgradeKind;
      const targetTier = parseUpgradeTier(dataset.targetTier);
      return isUpgradeKind(upgrade) && targetTier !== null
        ? { type: 'upgrade', vehicleInstanceId, upgrade, targetTier }
        : null;
    }
    case 'repair-all':
      return { type: 'repair-all', vehicleInstanceId };
    case 'retrieve':
      return { type: 'retrieve', vehicleInstanceId };
    case 'paint': {
      const paint = dataset.paintId;
      return isGaragePaint(paint)
        ? { type: 'paint', vehicleInstanceId, paint }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Event-delegation helper. It intentionally uses a structural target check so
 * the parser remains testable in the node-only unit environment.
 */
export function parseGaragePanelAction(
  target: EventTarget | null,
): GaragePanelAction | null {
  if (!hasClosest(target)) {
    return null;
  }
  const actionTarget = target.closest('[data-garage-action]');
  if (!hasDataset(actionTarget) || actionTarget.disabled === true) {
    return null;
  }
  return parseGarageActionDataset(actionTarget.dataset);
}

export function formatGarageCash(cash: number): string {
  if (!Number.isSafeInteger(cash) || cash < 0) {
    return '$0';
  }
  return `$${cash.toLocaleString('en-US')}`;
}

export class GaragePanel {
  readonly #target: HTMLElement;
  readonly #vehicleDefinitions: readonly VehicleDefinition[];

  public constructor(target: HTMLElement, options: GaragePanelOptions = {}) {
    this.#target = target;
    this.#vehicleDefinitions = options.vehicleDefinitions ?? VEHICLES;
  }

  public draw(
    state: Readonly<GarageState>,
    candidate: Readonly<NearbyUnregisteredVehicle> | null = null,
  ): GaragePanelModel {
    const model = createGaragePanelModel(state, candidate, this.#vehicleDefinitions);
    this.#target.innerHTML = renderGaragePanel(model);
    return model;
  }

  public clear(): void {
    this.#target.innerHTML = '';
  }
}

function createVehicleModel(
  state: Readonly<GarageState>,
  vehicle: Readonly<SavedVehicle>,
  definition: Readonly<VehicleDefinition> | undefined,
): GarageVehiclePanelModel {
  const trunk = state.trunks[vehicle.instanceId];
  const repairCost = definition ? quoteVehicleRepair(vehicle, definition, 'all') : 0;
  const repair = availability(
    !definition
      ? 'Vehicle definition unavailable'
      : repairCost === 0
        ? 'Vehicle is fully repaired'
        : state.cash < repairCost
          ? `Requires ${formatGarageCash(repairCost)}`
          : null,
  );
  const tireHealthAverage = vehicle.tireHealth.reduce(
    (total, health) => total + health,
    0,
  ) / vehicle.tireHealth.length;
  const active = vehicle.garageSlot === 0;
  return {
    instanceId: vehicle.instanceId,
    definitionId: vehicle.definitionId,
    name: definition?.name ?? `Unknown vehicle (${vehicle.definitionId})`,
    garageSlot: vehicle.garageSlot,
    slotLabel: `Garage slot ${vehicle.garageSlot + 1}`,
    active,
    retrieve: availability(active ? 'Vehicle is already active' : null),
    bodyHealth: clampHealth(vehicle.bodyHealth),
    engineHealth: clampHealth(vehicle.engineHealth),
    tireHealthAverage: clampHealth(tireHealthAverage),
    operatingState: vehicleOperatingState(vehicle),
    operatingStateLabel: vehicleOperatingState(vehicle) === 'engine-disabled'
      ? 'Engine disabled — repair required'
      : 'Operational',
    trunkColumns: trunk?.gridWidth ?? 0,
    trunkRows: trunk?.gridHeight ?? 0,
    trunkItemQuantity: trunk?.items.reduce((total, item) => total + item.quantity, 0) ?? 0,
    upgrades: UPGRADE_KINDS.map((kind) => createUpgradeModel(
      state.cash,
      vehicle,
      definition,
      kind,
    )),
    repairCost,
    repairCostLabel: formatGarageCash(repairCost),
    repair,
    paints: GARAGE_PAINTS.map((paint) => createPaintModel(
      state.cash,
      vehicle,
      definition,
      paint,
    )),
  };
}

function createUpgradeModel(
  cash: number,
  vehicle: Readonly<SavedVehicle>,
  definition: Readonly<VehicleDefinition> | undefined,
  kind: VehicleUpgradeKind,
): GarageUpgradeButtonModel {
  const currentTier = vehicle.upgrades[kind];
  const targetTier = currentTier >= 0 && currentTier < 3
    ? (currentTier + 1) as VehicleUpgradeTier
    : null;
  const cost = definition && targetTier
    ? quoteVehicleUpgrade(definition, kind, targetTier)
    : 0;
  const reason = !definition
    ? 'Vehicle definition unavailable'
    : targetTier === null
      ? 'Maximum tier installed'
      : cash < cost
        ? `Requires ${formatGarageCash(cost)}`
        : null;
  return {
    kind,
    label: UPGRADE_LABELS[kind],
    currentTier,
    targetTier,
    cost,
    costLabel: formatGarageCash(cost),
    ...availability(reason),
  };
}

function createPaintModel(
  cash: number,
  vehicle: Readonly<SavedVehicle>,
  definition: Readonly<VehicleDefinition> | undefined,
  paint: GaragePaint,
): GaragePaintButtonModel {
  const selected = vehicle.upgrades.paint === paint;
  const cost = definition ? quoteVehiclePaint(definition) : 0;
  const reason = !definition
    ? 'Vehicle definition unavailable'
    : selected
      ? 'Current paint'
      : cash < cost
        ? `Requires ${formatGarageCash(cost)}`
        : null;
  return {
    id: paint,
    label: PAINT_LABELS[paint],
    selected,
    cost,
    costLabel: formatGarageCash(cost),
    ...availability(reason),
  };
}

function createCandidateModel(
  state: Readonly<GarageState>,
  candidate: Readonly<NearbyUnregisteredVehicle>,
  definition: Readonly<VehicleDefinition> | undefined,
): GarageCandidatePanelModel {
  const discount = candidate.registrationDiscountPercent ?? 0;
  const validDiscount = Number.isFinite(discount) && discount >= 0 && discount <= 100;
  const registrationCost = definition && validDiscount
    ? quoteRegistrationFee(definition, discount)
    : 0;
  const reason = !isSafeActionId(candidate.instanceId)
    ? 'Vehicle instance identifier is invalid'
    : state.ownedVehicles.some((vehicle) => vehicle.instanceId === candidate.instanceId)
      ? 'Vehicle is already owned'
      : !definition
        ? 'Vehicle definition unavailable'
        : !definition.registerable
          ? 'This vehicle cannot be registered'
          : state.ownedVehicles.length >= GARAGE_SLOT_COUNT
            ? 'Garage storage is full'
            : !validDiscount
              ? 'Registration discount is invalid'
              : state.cash < registrationCost
                ? `Requires ${formatGarageCash(registrationCost)}`
                : null;
  return {
    instanceId: candidate.instanceId,
    definitionId: candidate.definitionId,
    name: definition?.name ?? `Unknown vehicle (${candidate.definitionId})`,
    registerable: definition?.registerable ?? false,
    registrationCost,
    registrationCostLabel: formatGarageCash(registrationCost),
    ...availability(reason),
  };
}

function renderCandidate(candidate: Readonly<GarageCandidatePanelModel> | null): string {
  const parts = [
    '<section class="garage-panel__candidate" aria-labelledby="garage-candidate-title">',
    '<h3 id="garage-candidate-title">Nearby vehicle</h3>',
  ];
  if (!candidate) {
    parts.push('<p data-garage-candidate="none">No unregistered vehicle is in the service bay.</p>');
  } else {
    const disabled = disabledAttributes(candidate);
    parts.push(
      `<article data-garage-candidate="${escapeHtml(candidate.instanceId)}" data-vehicle-definition-id="${escapeHtml(candidate.definitionId)}">`,
      `<h4>${escapeHtml(candidate.name)}</h4>`,
      `<p>Registration fee: <strong>${escapeHtml(candidate.registrationCostLabel)}</strong></p>`,
      `<button type="button" data-garage-action="register" data-vehicle-instance-id="${escapeHtml(candidate.instanceId)}" data-vehicle-definition-id="${escapeHtml(candidate.definitionId)}" aria-label="Register ${escapeHtml(candidate.name)} for ${escapeHtml(candidate.registrationCostLabel)}"${disabled}>Register vehicle · ${escapeHtml(candidate.registrationCostLabel)}</button>`,
      renderReason(candidate.reason),
      '</article>',
    );
  }
  parts.push('</section>');
  return parts.join('');
}

function renderVehicle(vehicle: Readonly<GarageVehiclePanelModel>): string {
  const parts = [
    `<article class="garage-panel__vehicle" data-garage-vehicle="${escapeHtml(vehicle.instanceId)}" data-garage-slot="${vehicle.garageSlot}" data-operating-state="${vehicle.operatingState}">`,
    '<header>',
    `<p>${escapeHtml(vehicle.slotLabel)}</p>`,
    `<h4>${escapeHtml(vehicle.name)}</h4>`,
    `<p data-vehicle-instance-label="true">Vehicle ID: ${escapeHtml(vehicle.instanceId)}</p>`,
    `<p data-garage-active="${vehicle.active}">${vehicle.active ? 'Active vehicle' : 'Stored vehicle'}</p>`,
    `<p role="status">${escapeHtml(vehicle.operatingStateLabel)}</p>`,
    '</header>',
    `<button type="button" data-garage-action="retrieve" data-vehicle-instance-id="${escapeHtml(vehicle.instanceId)}" aria-label="Retrieve ${escapeHtml(vehicle.name)}"${disabledAttributes(vehicle.retrieve)}>Retrieve vehicle</button>`,
    renderReason(vehicle.retrieve.reason),
    '<div class="garage-panel__condition" role="group" aria-label="Vehicle condition">',
    renderHealthMeter('Body', vehicle.bodyHealth),
    renderHealthMeter('Engine', vehicle.engineHealth),
    renderHealthMeter('Tires average', vehicle.tireHealthAverage),
    '</div>',
    `<p data-trunk-capacity="${vehicle.trunkColumns}x${vehicle.trunkRows}">Trunk: ${vehicle.trunkColumns} × ${vehicle.trunkRows}; ${vehicle.trunkItemQuantity} ${plural(vehicle.trunkItemQuantity, 'item')}</p>`,
    '<fieldset class="garage-panel__upgrades"><legend>Mechanical upgrades</legend>',
  ];
  for (const upgrade of vehicle.upgrades) {
    const targetTier = upgrade.targetTier ?? 3;
    parts.push(
      '<div class="garage-panel__service-row">',
      `<span>${escapeHtml(upgrade.label)} · tier ${upgrade.currentTier}/3</span>`,
      `<button type="button" data-garage-action="upgrade" data-vehicle-instance-id="${escapeHtml(vehicle.instanceId)}" data-upgrade-kind="${upgrade.kind}" data-target-tier="${targetTier}" aria-label="Upgrade ${escapeHtml(vehicle.name)} ${escapeHtml(upgrade.label.toLowerCase())} to tier ${targetTier} for ${escapeHtml(upgrade.costLabel)}"${disabledAttributes(upgrade)}>Tier ${targetTier} · ${escapeHtml(upgrade.costLabel)}</button>`,
      renderReason(upgrade.reason),
      '</div>',
    );
  }
  parts.push(
    '</fieldset>',
    '<fieldset class="garage-panel__paint"><legend>Paint</legend>',
  );
  for (const paint of vehicle.paints) {
    parts.push(
      `<button type="button" data-garage-action="paint" data-vehicle-instance-id="${escapeHtml(vehicle.instanceId)}" data-paint-id="${paint.id}" aria-pressed="${paint.selected}" aria-label="Paint ${escapeHtml(vehicle.name)} ${escapeHtml(paint.label)} for ${escapeHtml(paint.costLabel)}"${disabledAttributes(paint)}>${escapeHtml(paint.label)} · ${escapeHtml(paint.costLabel)}</button>`,
    );
  }
  parts.push(
    '</fieldset>',
    '<div class="garage-panel__repair">',
    `<button type="button" data-garage-action="repair-all" data-vehicle-instance-id="${escapeHtml(vehicle.instanceId)}" aria-label="Repair all damage on ${escapeHtml(vehicle.name)} for ${escapeHtml(vehicle.repairCostLabel)}"${disabledAttributes(vehicle.repair)}>Repair all · ${escapeHtml(vehicle.repairCostLabel)}</button>`,
    renderReason(vehicle.repair.reason),
    '</div>',
    '</article>',
  );
  return parts.join('');
}

function renderHealthMeter(label: string, health: number): string {
  const rounded = Math.round(health);
  return `<div><span>${escapeHtml(label)}</span><meter min="0" max="100" value="${formatNumber(health)}" aria-label="${escapeHtml(label)} health ${rounded} percent">${rounded}%</meter><span aria-hidden="true">${rounded}%</span></div>`;
}

function renderReason(reason: string | null): string {
  return reason
    ? `<small class="garage-panel__action-reason">${escapeHtml(reason)}</small>`
    : '';
}

function disabledAttributes(availability: Readonly<GarageActionAvailability>): string {
  return availability.enabled
    ? ''
    : ` disabled aria-disabled="true"${availability.reason ? ` title="${escapeHtml(availability.reason)}"` : ''}`;
}

function availability(reason: string | null): GarageActionAvailability {
  return { enabled: reason === null, reason };
}

function compareVehicles(left: Readonly<SavedVehicle>, right: Readonly<SavedVehicle>): number {
  return left.garageSlot - right.garageSlot || left.instanceId.localeCompare(right.instanceId);
}

function clampHealth(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseUpgradeTier(value: string | undefined): VehicleUpgradeTier | null {
  return value === '1' || value === '2' || value === '3'
    ? Number(value) as VehicleUpgradeTier
    : null;
}

function isUpgradeKind(value: unknown): value is VehicleUpgradeKind {
  return value === 'engine' || value === 'brakes' || value === 'grip' || value === 'armor';
}

function isGaragePaint(value: unknown): value is GaragePaint {
  return typeof value === 'string' && (GARAGE_PAINTS as readonly string[]).includes(value);
}

function isSafeActionId(value: unknown): value is string {
  return typeof value === 'string'
    && ACTION_ID_PATTERN.test(value)
    && !RESERVED_ACTION_IDS.has(value);
}

interface ClosestTarget extends EventTarget {
  closest(selector: string): unknown;
}

interface DatasetTarget {
  readonly dataset: GarageActionDataset;
  readonly disabled?: boolean;
}

function hasClosest(value: unknown): value is ClosestTarget {
  return typeof value === 'object'
    && value !== null
    && 'closest' in value
    && typeof value.closest === 'function';
}

function hasDataset(value: unknown): value is DatasetTarget {
  return typeof value === 'object'
    && value !== null
    && 'dataset' in value
    && typeof value.dataset === 'object'
    && value.dataset !== null;
}
