import { describe, expect, it } from 'vitest';
import { createInitialProgressionState } from '../../src/systems/progression';
import { createEconomyState } from '../../src/systems/economy';
import {
  createEconomyPanelModel,
  parseEconomyPanelActionDataset,
  renderEconomyPanel,
} from '../../src/ui/EconomyPanel';

describe('EconomyPanel', () => {
  it('renders both shops and all five authored properties', () => {
    const model = createEconomyPanelModel({
      economy: createEconomyState(40_000),
      ending: null,
      progression: createInitialProgressionState(),
    });
    expect(model.shopItems.length).toBeGreaterThan(10);
    expect(model.properties).toHaveLength(5);
    expect(renderEconomyPanel(model)).toContain('data-economy-panel="true"');
  });

  it('reports atomic inventory rejection before a shop purchase', () => {
    const model = createEconomyPanelModel({
      economy: createEconomyState(40_000),
      ending: null,
      progression: createInitialProgressionState(),
      inventoryCanAccept: { medkit: false },
    });
    const medkit = model.shopItems.find((item) => item.id === 'medkit');
    expect(medkit?.available).toBe(false);
    expect(medkit?.reason).toContain('Backpack');
    const html = renderEconomyPanel(model);
    expect(html).toContain('disabled aria-disabled="true"');
    expect(html).toContain('title="Backpack has no valid space or weight capacity"');
  });

  it('parses typed actions and rejects unsafe ids', () => {
    expect(parseEconomyPanelActionDataset({ economyAction: 'buy-item', itemId: 'medkit', market: 'legitimate' }))
      .toEqual({ type: 'buy-item', itemId: 'medkit', market: 'legitimate' });
    expect(parseEconomyPanelActionDataset({ economyAction: 'collect-all' })).toEqual({ type: 'collect-all' });
    expect(parseEconomyPanelActionDataset({ economyAction: 'purchase-property', propertyId: '__proto__' })).toBeNull();
    expect(parseEconomyPanelActionDataset({ economyAction: 'purchase-property', propertyId: 'unknown-property' })).toBeNull();
    expect(parseEconomyPanelActionDataset({ economyAction: 'buy-item', itemId: 'medkit', market: 'black-market' })).toBeNull();
    expect(parseEconomyPanelActionDataset({ economyAction: 'buy-item', itemId: 'craft-component', market: 'legitimate' })).toBeNull();
  });

  it('escapes dynamic property identifiers before placing them in HTML attributes', () => {
    const model = createEconomyPanelModel({
      economy: createEconomyState(40_000),
      ending: null,
      progression: createInitialProgressionState(),
    });
    const property = model.properties[0];
    if (!property) throw new Error('Expected a property fixture');
    const html = renderEconomyPanel({
      ...model,
      properties: [{ ...property, id: '"><img src=x onerror=alert(1)>' }],
    });

    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });
});
