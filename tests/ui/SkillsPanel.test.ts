import { describe, expect, it } from 'vitest';
import {
  createSkillsPanelModel,
  parseSkillsPanelActionDataset,
  renderSkillsPanel,
} from '../../src/ui/SkillsPanel';
import { createInitialProgressionState, grantXp } from '../../src/systems/progression';
import type { SkillNodeDefinition } from '../../src/data/types';

describe('SkillsPanel', () => {
  it('renders all attributes and 24 skill nodes from the authoritative catalog', () => {
    const model = createSkillsPanelModel(createInitialProgressionState());
    expect(model.attributes).toHaveLength(5);
    expect(model.trees).toHaveLength(3);
    expect(model.trees.flatMap((tree) => tree.nodes)).toHaveLength(24);
    expect(renderSkillsPanel(model)).toContain('data-skills-panel="true"');
  });

  it('shows spendable points and tier-one skills after leveling', () => {
    const progressed = grantXp(createInitialProgressionState(), 1_300).state;
    const model = createSkillsPanelModel(progressed);
    expect(model.level).toBe(3);
    expect(model.skillPoints).toBe(2);
    expect(model.attributePoints).toBe(1);
    expect(model.attributes.every((attribute) => attribute.available)).toBe(true);
    expect(model.trees.flatMap((tree) => tree.nodes).filter((node) => node.tier === 1).every((node) => node.available)).toBe(true);
  });

  it('uses injected skill definitions consistently for nodes and measured modifiers', () => {
    const customSkill: SkillNodeDefinition = {
      id: 'combat-custom-conditioning',
      tree: 'combat',
      name: 'Custom Conditioning',
      description: 'Test-only health modifier.',
      tier: 1,
      cost: 1,
      requiredNodesInTree: 0,
      capstone: false,
      exclusiveWith: null,
      effects: [{ stat: 'maximumHealth', operation: 'add', value: 25 }],
    };
    const state = {
      ...createInitialProgressionState(),
      unlockedSkills: [customSkill.id],
    };

    const model = createSkillsPanelModel(state, [customSkill]);

    expect(model.trees[0]?.nodes).toHaveLength(1);
    expect(model.modifiers.maximumHealth).toBe(125);
  });

  it('parses only safe, typed action datasets', () => {
    expect(parseSkillsPanelActionDataset({ progressionAction: 'attribute', attributeId: 'grit' }))
      .toEqual({ type: 'attribute', attributeId: 'grit' });
    expect(parseSkillsPanelActionDataset({ progressionAction: 'skill', skillId: 'combat-fast-hands' }))
      .toEqual({ type: 'skill', skillId: 'combat-fast-hands' });
    expect(parseSkillsPanelActionDataset({ progressionAction: 'skill', skillId: '__proto__' })).toBeNull();
    expect(parseSkillsPanelActionDataset({ progressionAction: 'attribute', attributeId: 'luck' })).toBeNull();
  });

  it('exposes disabled reasons to assistive technology', () => {
    const html = renderSkillsPanel(createSkillsPanelModel(createInitialProgressionState()));
    expect(html).toContain('disabled aria-disabled="true"');
    expect(html).toContain('title="Earn an attribute point at an even level"');
  });
});
