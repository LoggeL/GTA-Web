import { describe, expect, it } from 'vitest';

import type { VehicleDefinition } from '../../src/data/types';
import { VEHICLES } from '../../src/data/vehicles';
import {
  applyVehicleUpgrade,
  createGarageState,
  registerVehicle,
} from '../../src/systems/garage';
import type { GarageState } from '../../src/systems/garage';
import {
  GaragePanel,
  createGaragePanelModel,
  formatGarageCash,
  parseGarageActionDataset,
  parseGaragePanelAction,
  renderGaragePanel,
} from '../../src/ui/GaragePanel';

function mustRegister(
  state: Readonly<GarageState>,
  instanceId: string,
  definitionId: string,
  condition: { bodyHealth?: number; engineHealth?: number } = {},
): GarageState {
  const result = registerVehicle(state, VEHICLES, {
    instanceId,
    definitionId,
    ...condition,
  });
  if (!result.success) throw new Error(result.reason);
  return result.state;
}

function panelState(): GarageState {
  let state = mustRegister(
    createGarageState(100_000),
    'alex-sedan',
    'sedan',
    { bodyHealth: 55, engineHealth: 0 },
  );
  const upgraded = applyVehicleUpgrade(state, VEHICLES, {
    instanceId: 'alex-sedan',
    upgrade: 'engine',
    targetTier: 1,
  });
  if (!upgraded.success) throw new Error(upgraded.reason);
  state = upgraded.state;
  return state;
}

function fullGarage(): GarageState {
  let state = createGarageState(1_000_000);
  const registerable = VEHICLES.filter((definition) => definition.registerable);
  for (let index = 0; index < 8; index += 1) {
    const definition = registerable[index % registerable.length];
    if (!definition) throw new Error('Missing test vehicle definition');
    state = mustRegister(state, `owned-${index}`, definition.id);
  }
  return state;
}

describe('GaragePanel view model', () => {
  it('models owned condition, sequential service actions, paint, and a candidate quote', () => {
    const state = panelState();
    const model = createGaragePanelModel(state, {
      instanceId: 'nearby-compact',
      definitionId: 'compact',
      registrationDiscountPercent: 10,
    });

    expect(model.cashLabel).toBe(formatGarageCash(state.cash));
    expect(model.slotSummary).toBe('1 of 8 garage slots occupied');
    expect(model.availableSlots).toBe(7);
    expect(model.candidate).toEqual(expect.objectContaining({
      instanceId: 'nearby-compact',
      definitionId: 'compact',
      name: 'Sunskip Compact',
      registrationCost: 612,
      registrationCostLabel: '$612',
      enabled: true,
      reason: null,
    }));

    const vehicle = model.vehicles[0];
    expect(vehicle).toEqual(expect.objectContaining({
      instanceId: 'alex-sedan',
      name: 'Meridian Sedan',
      garageSlot: 0,
      slotLabel: 'Garage slot 1',
      active: true,
      bodyHealth: 55,
      engineHealth: 0,
      operatingState: 'engine-disabled',
      trunkColumns: 6,
      trunkRows: 4,
      trunkItemQuantity: 0,
    }));
    expect(vehicle?.retrieve).toEqual({
      enabled: false,
      reason: 'Vehicle is already active',
    });
    expect(vehicle?.repair.enabled).toBe(true);
    expect(vehicle?.repairCost).toBeGreaterThan(0);
    expect(vehicle?.upgrades.find(({ kind }) => kind === 'engine')).toEqual(
      expect.objectContaining({ currentTier: 1, targetTier: 2, enabled: true }),
    );
    expect(vehicle?.upgrades.find(({ kind }) => kind === 'brakes')).toEqual(
      expect.objectContaining({ currentTier: 0, targetTier: 1, enabled: true }),
    );
    expect(vehicle?.paints.find(({ id }) => id === 'factory')).toEqual(
      expect.objectContaining({ selected: true, enabled: false, reason: 'Current paint' }),
    );
  });

  it('surfaces deterministic candidate and service disabled reasons', () => {
    const police = createGaragePanelModel(createGarageState(10_000), {
      instanceId: 'nearby-police',
      definitionId: 'police-cruiser',
    });
    expect(police.candidate).toEqual(expect.objectContaining({
      registerable: false,
      enabled: false,
      reason: 'This vehicle cannot be registered',
    }));

    const full = createGaragePanelModel(fullGarage(), {
      instanceId: 'overflow',
      definitionId: 'compact',
    });
    expect(full.candidate?.reason).toBe('Garage storage is full');

    const reserved = createGaragePanelModel(createGarageState(10_000), {
      instanceId: '__proto__',
      definitionId: 'compact',
    });
    expect(reserved.candidate?.reason).toBe('Vehicle instance identifier is invalid');

    const poorState = { ...panelState(), cash: 0 };
    const poor = createGaragePanelModel(poorState, {
      instanceId: 'candidate',
      definitionId: 'compact',
    });
    expect(poor.candidate?.enabled).toBe(false);
    expect(poor.candidate?.reason).toContain('Requires');
    expect(poor.vehicles[0]?.repair.reason).toContain('Requires');
    expect(poor.vehicles[0]?.upgrades.every(({ enabled }) => !enabled)).toBe(true);
  });

  it('disables a maximum upgrade while keeping the next-tier model deterministic', () => {
    let state = mustRegister(createGarageState(1_000_000), 'maxed', 'compact');
    for (const targetTier of [1, 2, 3] as const) {
      const result = applyVehicleUpgrade(state, VEHICLES, {
        instanceId: 'maxed',
        upgrade: 'grip',
        targetTier,
      });
      if (!result.success) throw new Error(result.reason);
      state = result.state;
    }
    const grip = createGaragePanelModel(state).vehicles[0]?.upgrades.find(
      ({ kind }) => kind === 'grip',
    );
    expect(grip).toEqual(expect.objectContaining({
      currentTier: 3,
      targetTier: null,
      cost: 0,
      enabled: false,
      reason: 'Maximum tier installed',
    }));
  });
});

describe('GaragePanel accessible markup', () => {
  it('renders semantic status, meters, action buttons, and deterministic datasets', () => {
    const html = renderGaragePanel(createGaragePanelModel(panelState(), {
      instanceId: 'nearby-compact',
      definitionId: 'compact',
    }));

    expect(html).toContain('<section class="garage-panel"');
    expect(html).toContain('aria-labelledby="garage-panel-title"');
    expect(html).toContain('<dl class="garage-panel__summary" aria-label="Garage summary">');
    expect(html).toContain('<ol class="garage-panel__vehicle-list">');
    expect(html).toContain('<fieldset class="garage-panel__upgrades"><legend>Mechanical upgrades</legend>');
    expect(html).toContain('<meter min="0" max="100" value="0" aria-label="Engine health 0 percent">');
    expect(html).toContain('role="status"');
    expect(html.match(/data-garage-action="upgrade"/g)).toHaveLength(4);
    expect(html.match(/data-garage-action="paint"/g)).toHaveLength(4);
    expect(html.match(/data-garage-action="repair-all"/g)).toHaveLength(1);
    expect(html.match(/data-garage-action="register"/g)).toHaveLength(1);
    expect(html.match(/data-garage-action="retrieve"/g)).toHaveLength(1);
    expect(html).toContain('data-upgrade-kind="engine" data-target-tier="2"');
    expect(html).toContain('data-vehicle-instance-id="alex-sedan"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('disabled aria-disabled="true" title="Current paint"');
  });

  it('escapes authored and candidate text before writing innerHTML', () => {
    const authored = VEHICLES.map((definition) => (
      definition.id === 'compact'
        ? { ...definition, name: 'A&B <Roadster> "Special"' }
        : definition
    )) as readonly VehicleDefinition[];
    const model = createGaragePanelModel(
      createGarageState(10_000),
      { instanceId: 'candidate-safe', definitionId: 'compact' },
      authored,
    );
    const html = renderGaragePanel(model);
    expect(html).toContain('A&amp;B &lt;Roadster&gt; &quot;Special&quot;');
    expect(html).not.toContain('A&B <Roadster> "Special"');
  });

  it('renders explicit empty and no-candidate states', () => {
    const html = renderGaragePanel(createGaragePanelModel(createGarageState()));
    expect(html).toContain('data-garage-empty="true"');
    expect(html).toContain('data-garage-candidate="none"');
    expect(html).toContain('No registered vehicles');
  });
});

describe('GaragePanel action parsing and renderer', () => {
  it('parses each typed action and rejects incomplete, invalid, or reserved datasets', () => {
    expect(parseGarageActionDataset({
      garageAction: 'register',
      vehicleInstanceId: 'candidate',
      vehicleDefinitionId: 'compact',
    })).toEqual({
      type: 'register',
      vehicleInstanceId: 'candidate',
      vehicleDefinitionId: 'compact',
    });
    expect(parseGarageActionDataset({
      garageAction: 'upgrade',
      vehicleInstanceId: 'owned',
      upgradeKind: 'armor',
      targetTier: '2',
    })).toEqual({
      type: 'upgrade',
      vehicleInstanceId: 'owned',
      upgrade: 'armor',
      targetTier: 2,
    });
    expect(parseGarageActionDataset({
      garageAction: 'repair-all',
      vehicleInstanceId: 'owned',
    })).toEqual({ type: 'repair-all', vehicleInstanceId: 'owned' });
    expect(parseGarageActionDataset({
      garageAction: 'paint',
      vehicleInstanceId: 'owned',
      paintId: 'coastal-teal',
    })).toEqual({ type: 'paint', vehicleInstanceId: 'owned', paint: 'coastal-teal' });
    expect(parseGarageActionDataset({
      garageAction: 'retrieve',
      vehicleInstanceId: 'owned',
    })).toEqual({ type: 'retrieve', vehicleInstanceId: 'owned' });

    expect(parseGarageActionDataset({
      garageAction: 'upgrade',
      vehicleInstanceId: 'owned',
      upgradeKind: 'engine',
      targetTier: '4',
    })).toBeNull();
    expect(parseGarageActionDataset({
      garageAction: 'paint',
      vehicleInstanceId: 'owned',
      paintId: 'not-authored',
    })).toBeNull();
    expect(parseGarageActionDataset({
      garageAction: 'repair-all',
      vehicleInstanceId: '__proto__',
    })).toBeNull();
    expect(parseGarageActionDataset({
      garageAction: 'repair-all',
      vehicleInstanceId: 'unsafe id',
    })).toBeNull();
    expect(parseGarageActionDataset({ garageAction: 'register' })).toBeNull();
  });

  it('delegates from a child target and ignores disabled or unrelated controls', () => {
    const button = {
      disabled: false,
      dataset: {
        garageAction: 'repair-all',
        vehicleInstanceId: 'owned',
      },
    };
    const child = {
      closest: (selector: string) => selector === '[data-garage-action]' ? button : null,
    } as unknown as EventTarget;
    expect(parseGaragePanelAction(child)).toEqual({
      type: 'repair-all',
      vehicleInstanceId: 'owned',
    });
    button.disabled = true;
    expect(parseGaragePanelAction(child)).toBeNull();
    expect(parseGaragePanelAction({ closest: () => null } as unknown as EventTarget)).toBeNull();
    expect(parseGaragePanelAction(null)).toBeNull();
  });

  it('draws deterministically into a host and clears without retaining state', () => {
    const target = { innerHTML: '' } as HTMLElement;
    const panel = new GaragePanel(target);
    const model = panel.draw(panelState(), {
      instanceId: 'candidate',
      definitionId: 'compact',
    });
    const firstHtml = target.innerHTML;
    expect(model.vehicles).toHaveLength(1);
    expect(firstHtml).toBe(renderGaragePanel(model));
    panel.draw(panelState(), {
      instanceId: 'candidate',
      definitionId: 'compact',
    });
    expect(target.innerHTML).toBe(firstHtml);
    panel.clear();
    expect(target.innerHTML).toBe('');
  });
});
