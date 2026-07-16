import type { AttributeId, SkillNodeDefinition, SkillTreeId } from '../data/types';
import { ATTRIBUTES, SKILL_NODES } from '../data/progression';
import {
  calculateProgressionModifiers,
  countSkillsInTree,
  levelProgress,
  purchaseAttribute,
  purchaseSkill,
  type ProgressionModifiers,
  type ProgressionState,
} from '../systems/progression';

export type SkillsPanelAction =
  | { readonly type: 'attribute'; readonly attributeId: AttributeId }
  | { readonly type: 'skill'; readonly skillId: string };

export interface SkillsPanelActionDataset {
  readonly progressionAction?: string;
  readonly attributeId?: string;
  readonly skillId?: string;
}

export interface AttributePanelModel {
  readonly id: AttributeId;
  readonly name: string;
  readonly description: string;
  readonly value: number;
  readonly maximum: number;
  readonly effects: readonly string[];
  readonly available: boolean;
  readonly reason: string | null;
}

export interface SkillNodePanelModel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tier: number;
  readonly capstone: boolean;
  readonly unlocked: boolean;
  readonly available: boolean;
  readonly reason: string | null;
}

export interface SkillTreePanelModel {
  readonly id: SkillTreeId;
  readonly label: string;
  readonly unlockedCount: number;
  readonly nodes: readonly SkillNodePanelModel[];
}

export interface SkillsPanelModel {
  readonly level: number;
  readonly xp: number;
  readonly xpLabel: string;
  readonly xpPercent: number;
  readonly capped: boolean;
  readonly attributePoints: number;
  readonly skillPoints: number;
  readonly attributes: readonly AttributePanelModel[];
  readonly trees: readonly SkillTreePanelModel[];
  readonly modifiers: ProgressionModifiers;
}

const ATTRIBUTE_IDS = new Set<AttributeId>(['grit', 'aim', 'handling', 'nerve', 'hustle']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TREE_LABELS: Readonly<Record<SkillTreeId, string>> = {
  combat: 'Combat',
  driving: 'Driving',
  streetcraft: 'Streetcraft',
};

export function createSkillsPanelModel(
  state: Readonly<ProgressionState>,
  skillDefinitions: readonly SkillNodeDefinition[] = SKILL_NODES,
): SkillsPanelModel {
  const progress = levelProgress(state);
  const attributes = ATTRIBUTES.map((definition): AttributePanelModel => {
    const transaction = purchaseAttribute(state, definition.id);
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      value: state.attributes[definition.id],
      maximum: definition.maximum,
      effects: definition.effectsPerAddedPoint.map((effect) => formatAttributeEffect(effect.stat, effect.amount, effect.unit)),
      available: transaction.success,
      reason: transaction.success ? null : friendlyReason(transaction.reason),
    };
  });
  const trees = (['combat', 'driving', 'streetcraft'] as const).map((tree): SkillTreePanelModel => ({
    id: tree,
    label: TREE_LABELS[tree],
    unlockedCount: countSkillsInTree(state, tree, skillDefinitions),
    nodes: skillDefinitions
      .filter((definition) => definition.tree === tree)
      .sort((left, right) => left.tier - right.tier || left.name.localeCompare(right.name))
      .map((definition): SkillNodePanelModel => {
        const unlocked = state.unlockedSkills.includes(definition.id);
        const transaction = unlocked ? null : purchaseSkill(state, definition.id, skillDefinitions);
        return {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          tier: definition.tier,
          capstone: definition.capstone,
          unlocked,
          available: transaction?.success ?? false,
          reason: unlocked ? 'Unlocked' : transaction?.success ? null : friendlyReason(transaction?.reason ?? 'Unavailable'),
        };
      }),
  }));

  return {
    level: state.level,
    xp: state.xp,
    xpLabel: progress.capped
      ? `${state.xp.toLocaleString('en-US')} XP · level cap`
      : `${progress.xpEarnedInLevel.toLocaleString('en-US')} / ${progress.xpRequiredInLevel.toLocaleString('en-US')} XP`,
    xpPercent: Math.round(progress.fraction * 100),
    capped: progress.capped,
    attributePoints: state.attributePoints,
    skillPoints: state.skillPoints,
    attributes,
    trees,
    modifiers: calculateProgressionModifiers(state, null, ATTRIBUTES, skillDefinitions),
  };
}

export function renderSkillsPanel(model: Readonly<SkillsPanelModel>): string {
  return [
    '<section class="skills-panel" data-skills-panel="true" aria-labelledby="skills-panel-title">',
    '<header class="skills-panel__header">',
    '<div><p class="eyebrow">Alex Moreno · progression</p>',
    `<h2 id="skills-panel-title">Level ${model.level}${model.capped ? ' · MAX' : ''}</h2>`,
    `<div class="skills-panel__xp" role="progressbar" aria-label="${escapeHtml(model.xpLabel)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${model.xpPercent}"><span style="--xp-progress:${model.xpPercent}%"></span></div>`,
    `<p>${escapeHtml(model.xpLabel)}</p></div>`,
    `<dl class="skills-panel__points"><div><dt>Attribute points</dt><dd data-attribute-points="${model.attributePoints}">${model.attributePoints}</dd></div><div><dt>Skill points</dt><dd data-skill-points="${model.skillPoints}">${model.skillPoints}</dd></div></dl>`,
    '</header>',
    '<section class="skills-panel__section" aria-labelledby="attribute-heading">',
    '<div class="skills-panel__section-heading"><div><p class="eyebrow">Build foundation</p><h3 id="attribute-heading">Attributes</h3></div>',
    `<p>Health ${Math.round(model.modifiers.maximumHealth)} · carry ${formatNumber(model.modifiers.backpackWeightKg)} kg · heat ×${formatNumber(model.modifiers.heatGainMultiplier)}</p></div>`,
    '<div class="attribute-grid">',
    ...model.attributes.map(renderAttribute),
    '</div></section>',
    '<section class="skills-panel__section" aria-labelledby="skill-heading">',
    '<div class="skills-panel__section-heading"><div><p class="eyebrow">Choose a specialty</p><h3 id="skill-heading">Skill trees</h3></div><p>Tier 2 needs two nodes. Capstones need five and are mutually exclusive.</p></div>',
    '<div class="skill-tree-grid">',
    ...model.trees.map(renderTree),
    '</div></section>',
    '</section>',
  ].join('');
}

export function parseSkillsPanelAction(target: EventTarget | null): SkillsPanelAction | null {
  if (!hasClosest(target)) return null;
  const actionTarget = target.closest('[data-progression-action]');
  if (!hasDataset(actionTarget) || actionTarget.disabled === true) return null;
  return parseSkillsPanelActionDataset(actionTarget.dataset);
}

export function parseSkillsPanelActionDataset(
  dataset: Readonly<SkillsPanelActionDataset>,
): SkillsPanelAction | null {
  if (dataset.progressionAction === 'attribute' && ATTRIBUTE_IDS.has(dataset.attributeId as AttributeId)) {
    return { type: 'attribute', attributeId: dataset.attributeId as AttributeId };
  }
  if (dataset.progressionAction === 'skill' && isSafeId(dataset.skillId)) {
    return { type: 'skill', skillId: dataset.skillId };
  }
  return null;
}

export class SkillsPanel {
  readonly #target: HTMLElement;

  public constructor(target: HTMLElement) {
    this.#target = target;
  }

  public draw(state: Readonly<ProgressionState>): SkillsPanelModel {
    const model = createSkillsPanelModel(state);
    this.#target.innerHTML = renderSkillsPanel(model);
    return model;
  }
}

function renderAttribute(attribute: Readonly<AttributePanelModel>): string {
  const pips = Array.from({ length: attribute.maximum }, (_, index) => (
    `<i class="${index < attribute.value ? 'is-filled' : ''}" aria-hidden="true"></i>`
  )).join('');
  const reason = attribute.reason ? `<small>${escapeHtml(attribute.reason)}</small>` : '<small>Spend one attribute point</small>';
  return `<article class="attribute-card" data-attribute="${escapeHtml(attribute.id)}">
    <header><div><h4>${escapeHtml(attribute.name)}</h4><span>${attribute.value} / ${attribute.maximum}</span></div><div class="attribute-card__pips">${pips}</div></header>
    <p>${escapeHtml(attribute.description)}</p>
    <ul>${attribute.effects.map((effect) => `<li>${escapeHtml(effect)}</li>`).join('')}</ul>
    <footer>${reason}<button type="button" data-progression-action="attribute" data-attribute-id="${escapeHtml(attribute.id)}"${disabledAttributes(attribute.available, attribute.reason)}>Increase ${escapeHtml(attribute.name)}</button></footer>
  </article>`;
}

function renderTree(tree: Readonly<SkillTreePanelModel>): string {
  return `<article class="skill-tree skill-tree--${tree.id}">
    <header><div><h4>${escapeHtml(tree.label)}</h4><p>${tree.unlockedCount} / 8 unlocked</p></div><span>${tree.unlockedCount}/8</span></header>
    <ol>${tree.nodes.map(renderSkillNode).join('')}</ol>
  </article>`;
}

function renderSkillNode(node: Readonly<SkillNodePanelModel>): string {
  const status = node.unlocked ? 'Unlocked' : node.available ? 'Unlock' : node.reason ?? 'Locked';
  return `<li class="skill-node ${node.unlocked ? 'is-unlocked' : node.available ? 'is-available' : 'is-locked'}" data-skill-id="${escapeHtml(node.id)}">
    <div><span>Tier ${node.tier}${node.capstone ? ' · Capstone' : ''}</span><h5>${escapeHtml(node.name)}</h5><p>${escapeHtml(node.description)}</p></div>
    <button type="button" data-progression-action="skill" data-skill-id="${escapeHtml(node.id)}" aria-label="${escapeHtml(status)} ${escapeHtml(node.name)}"${disabledAttributes(node.available, node.reason)}>${escapeHtml(status)}</button>
  </li>`;
}

function formatAttributeEffect(stat: string, amount: number, unit: 'flat' | 'percent'): string {
  const sign = amount > 0 ? '+' : '';
  const label = stat.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return `${sign}${amount}${unit === 'percent' ? '%' : ''} ${label} per point`;
}

function friendlyReason(reason: string): string {
  if (reason === 'no attribute points are available') return 'Earn an attribute point at an even level';
  if (reason === 'not enough skill points') return 'Earn a skill point by leveling up';
  if (reason.includes('already at its maximum')) return 'Maximum reached';
  if (reason.includes('requires')) return reason.replace(/^\S+ requires/, 'Requires');
  if (reason.includes('conflicts')) return 'Other capstone already chosen';
  return reason;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toLocaleString('en-US');
}

function disabledAttributes(available: boolean, reason: string | null): string {
  if (available) return '';
  return ` disabled aria-disabled="true"${reason ? ` title="${escapeHtml(reason)}"` : ''}`;
}

function isSafeId(value: string | undefined): value is string {
  return value !== undefined && SAFE_ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function hasClosest(value: unknown): value is { closest(selector: string): unknown } {
  return typeof value === 'object' && value !== null && 'closest' in value && typeof value.closest === 'function';
}

function hasDataset(value: unknown): value is { dataset: SkillsPanelActionDataset; disabled?: boolean } {
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
