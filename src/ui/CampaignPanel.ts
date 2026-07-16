import { ACTIVITIES } from '../data/economy';
import { MISSIONS } from '../data/missions';

export type CampaignPanelAction =
  | { readonly type: 'start-mission'; readonly missionId: string }
  | { readonly type: 'objective-action'; readonly objectiveId: string }
  | { readonly type: 'choose'; readonly objectiveId: string; readonly choice: 'rule' | 'expose' }
  | { readonly type: 'finish-mission' }
  | { readonly type: 'retry-mission' }
  | { readonly type: 'abandon-mission' }
  | { readonly type: 'advance-dialogue' }
  | { readonly type: 'skip-dialogue' }
  | { readonly type: 'start-activity'; readonly activityId: string; readonly difficultyId: string };

export interface CampaignPanelActionDataset {
  readonly campaignAction?: string;
  readonly missionId?: string;
  readonly objectiveId?: string;
  readonly choice?: string;
  readonly activityId?: string;
  readonly difficultyId?: string;
}

export type MissionCardState = 'locked' | 'available' | 'active' | 'complete';
export type ObjectiveCardState = 'pending' | 'active' | 'complete' | 'skipped';

export interface MissionCardModel {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly subtitle: string;
  readonly contact: string;
  readonly district: string;
  readonly state: MissionCardState;
  readonly gateReason: string | null;
  readonly cashReward: number;
  readonly xpReward: number;
}

export interface ObjectiveCardModel {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly type: string;
  readonly state: ObjectiveCardState;
  readonly current: number;
  readonly target: number;
  readonly distanceMeters: number | null;
  readonly actionLabel: string | null;
  readonly choices: readonly ('rule' | 'expose')[];
}

export interface DialogueLogModel {
  readonly key: string;
  readonly missionTitle: string;
  readonly speaker: string;
  readonly text: string;
}

export interface ActivityCardModel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly completions: number;
  readonly cooldownLabel: string | null;
  readonly bestLabel: string | null;
  readonly difficulties: readonly {
    readonly id: string;
    readonly label: string;
    readonly available: boolean;
    readonly reason: string | null;
  }[];
}

export interface CollectibleSetModel {
  readonly id: string;
  readonly label: string;
  readonly found: number;
  readonly total: number;
  readonly completed: boolean;
}

export interface CampaignPanelModel {
  readonly missions: readonly MissionCardModel[];
  readonly activeMission: MissionCardModel | null;
  readonly activeMissionStatus: 'active' | 'failed' | null;
  readonly objectives: readonly ObjectiveCardModel[];
  readonly canFinishMission: boolean;
  readonly contacts: Readonly<Record<'juno' | 'malik' | 'priya', number>>;
  readonly ending: 'rule' | 'expose' | null;
  readonly dialogue: {
    readonly current: DialogueLogModel | null;
    readonly hasNext: boolean;
    readonly history: readonly DialogueLogModel[];
  };
  readonly activities: readonly ActivityCardModel[];
  readonly collectibles: readonly CollectibleSetModel[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MISSION_IDS = new Set<string>(MISSIONS.map((mission) => mission.id));
const OBJECTIVE_IDS = new Set<string>(MISSIONS.flatMap((mission) => mission.objectives.map((objective) => objective.id)));
const ACTIVITY_IDS = new Set<string>(ACTIVITIES.map((activity) => activity.id));
const DIFFICULTY_IDS = new Set(['rookie', 'professional', 'legend']);

export function renderCampaignPanel(model: Readonly<CampaignPanelModel>): string {
  return [
    '<section class="campaign-panel" data-campaign-panel="true" aria-labelledby="campaign-panel-title">',
    renderHeader(model),
    renderActiveMission(model),
    '<section class="campaign-panel__section" aria-labelledby="jobs-heading">',
    '<div class="campaign-panel__section-heading"><div><p class="eyebrow">Contact board</p><h3 id="jobs-heading">Story jobs</h3></div><p>Chains can be interleaved; completed jobs remain reviewable.</p></div>',
    `<div class="mission-grid">${model.missions.map(renderMissionCard).join('')}</div>`,
    '</section>',
    renderActivities(model.activities),
    renderExploration(model.collectibles),
    renderMissionLog(model.dialogue.history),
    '</section>',
  ].join('');
}

export function parseCampaignPanelAction(target: EventTarget | null): CampaignPanelAction | null {
  if (!hasClosest(target)) return null;
  const actionTarget = target.closest('[data-campaign-action]');
  if (!hasDataset(actionTarget) || actionTarget.matches(':disabled')) return null;
  return parseCampaignPanelActionDataset(actionTarget.dataset);
}

export function parseCampaignPanelActionDataset(
  dataset: Readonly<CampaignPanelActionDataset>,
): CampaignPanelAction | null {
  switch (dataset.campaignAction) {
    case 'start-mission':
      return isKnownId(dataset.missionId, MISSION_IDS)
        ? { type: 'start-mission', missionId: dataset.missionId }
        : null;
    case 'objective-action':
      return isKnownId(dataset.objectiveId, OBJECTIVE_IDS)
        ? { type: 'objective-action', objectiveId: dataset.objectiveId }
        : null;
    case 'choose':
      return isKnownId(dataset.objectiveId, OBJECTIVE_IDS) && isEndingChoice(dataset.choice)
        ? { type: 'choose', objectiveId: dataset.objectiveId, choice: dataset.choice }
        : null;
    case 'finish-mission': return { type: 'finish-mission' };
    case 'retry-mission': return { type: 'retry-mission' };
    case 'abandon-mission': return { type: 'abandon-mission' };
    case 'advance-dialogue': return { type: 'advance-dialogue' };
    case 'skip-dialogue': return { type: 'skip-dialogue' };
    case 'start-activity':
      return isKnownId(dataset.activityId, ACTIVITY_IDS) && isKnownId(dataset.difficultyId, DIFFICULTY_IDS)
        ? { type: 'start-activity', activityId: dataset.activityId, difficultyId: dataset.difficultyId }
        : null;
    default: return null;
  }
}

export class CampaignPanel {
  readonly #target: HTMLElement;

  public constructor(target: HTMLElement) {
    this.#target = target;
  }

  public draw(model: Readonly<CampaignPanelModel>): void {
    this.#target.innerHTML = renderCampaignPanel(model);
  }
}

function renderHeader(model: Readonly<CampaignPanelModel>): string {
  const endingLabel = model.ending === null
    ? 'Undecided'
    : model.ending === 'rule' ? 'Rule ending' : 'Expose ending';
  return [
    '<header class="campaign-panel__header">',
    '<div><p class="eyebrow">Solara campaign</p><h2 id="campaign-panel-title">Jobs & mission log</h2><p>Twelve authored jobs, flexible contact order, repeatable work, and city discoveries.</p></div>',
    '<dl>',
    `<div><dt>Juno</dt><dd data-contact-reputation="juno">${model.contacts.juno}</dd></div>`,
    `<div><dt>Malik</dt><dd data-contact-reputation="malik">${model.contacts.malik}</dd></div>`,
    `<div><dt>Priya</dt><dd data-contact-reputation="priya">${model.contacts.priya}</dd></div>`,
    `<div><dt>Ending</dt><dd data-ending="${escapeHtml(model.ending ?? '')}">${escapeHtml(endingLabel)}</dd></div>`,
    '</dl></header>',
  ].join('');
}

function renderActiveMission(model: Readonly<CampaignPanelModel>): string {
  const mission = model.activeMission;
  if (!mission) {
    return '<section class="active-mission active-mission--empty"><p class="eyebrow">Current job</p><h3>Free roam</h3><p>Choose any available contact job below. Activities and discoveries remain open between missions.</p></section>';
  }
  const status = model.activeMissionStatus === 'failed' ? 'Checkpoint recovery ready' : 'In progress';
  return [
    `<section class="active-mission" data-active-mission-id="${escapeHtml(mission.id)}">`,
    `<header><div><p class="eyebrow">Mission ${mission.number} · ${escapeHtml(status)}</p><h3>${escapeHtml(mission.title)}</h3><p>${escapeHtml(mission.subtitle)}</p></div><span>${escapeHtml(mission.district)}</span></header>`,
    renderCurrentDialogue(model.dialogue),
    `<ol class="objective-list">${model.objectives.map(renderObjective).join('')}</ol>`,
    '<footer>',
    model.activeMissionStatus === 'failed'
      ? '<button type="button" data-campaign-action="retry-mission">Retry latest checkpoint</button>'
      : `<button type="button" data-campaign-action="finish-mission"${disabledAttributes(model.canFinishMission, 'Complete every active objective first')}>Complete mission</button>`,
    '<button type="button" class="button--quiet" data-campaign-action="abandon-mission">Abandon job</button>',
    '</footer></section>',
  ].join('');
}

function renderCurrentDialogue(dialogue: Readonly<CampaignPanelModel['dialogue']>): string {
  const line = dialogue.current;
  if (!line) return '';
  return [
    '<blockquote class="campaign-dialogue">',
    `<p><strong>${escapeHtml(line.speaker)}</strong> ${escapeHtml(line.text)}</p>`,
    '<div>',
    `<button type="button" data-campaign-action="advance-dialogue">${dialogue.hasNext ? 'Next line' : 'Close dialogue'}</button>`,
    '<button type="button" class="button--quiet" data-campaign-action="skip-dialogue">Skip</button>',
    '</div></blockquote>',
  ].join('');
}

function renderObjective(objective: Readonly<ObjectiveCardModel>): string {
  const progress = objective.target > 1
    ? `<span>${formatProgress(objective.current)} / ${formatProgress(objective.target)}</span>`
    : '';
  const distance = objective.distanceMeters === null
    ? ''
    : `<span>${Math.max(0, Math.round(objective.distanceMeters))} m</span>`;
  const controls = objective.state !== 'active'
    ? ''
    : objective.choices.length > 0
      ? `<div class="objective-choice">${objective.choices.map((choice) => `<button type="button" data-campaign-action="choose" data-objective-id="${escapeHtml(objective.id)}" data-choice="${choice}">${choice === 'rule' ? 'Rule' : 'Expose'}</button>`).join('')}</div>`
      : objective.actionLabel
        ? `<button type="button" data-campaign-action="objective-action" data-objective-id="${escapeHtml(objective.id)}">${escapeHtml(objective.actionLabel)}</button>`
        : '';
  return [
    `<li class="objective-card objective-card--${objective.state}" data-objective-id="${escapeHtml(objective.id)}" data-objective-state="${objective.state}">`,
    `<div><span>${escapeHtml(objective.type)}</span><h4>${escapeHtml(objective.title)}</h4><p>${escapeHtml(objective.description)}</p></div>`,
    `<aside>${progress}${distance}${controls}</aside>`,
    '</li>',
  ].join('');
}

function renderMissionCard(mission: Readonly<MissionCardModel>): string {
  const available = mission.state === 'available';
  const stateLabel = mission.state === 'complete' ? 'Complete' : mission.state === 'active' ? 'Active' : available ? 'Available' : 'Locked';
  return [
    `<article class="mission-card mission-card--${mission.state}" data-mission-id="${escapeHtml(mission.id)}">`,
    `<header><span>${String(mission.number).padStart(2, '0')}</span><div><p>${escapeHtml(mission.contact)} · ${escapeHtml(mission.district)}</p><h4>${escapeHtml(mission.title)}</h4></div><strong>${stateLabel}</strong></header>`,
    `<p>${escapeHtml(mission.subtitle)}</p>`,
    `<footer><span>$${mission.cashReward.toLocaleString('en-US')} · ${mission.xpReward.toLocaleString('en-US')} XP</span>`,
    available
      ? `<button type="button" data-campaign-action="start-mission" data-mission-id="${escapeHtml(mission.id)}">Start job</button>`
      : `<span class="mission-card__reason">${escapeHtml(mission.gateReason ?? stateLabel)}</span>`,
    '</footer></article>',
  ].join('');
}

function renderActivities(activities: readonly ActivityCardModel[]): string {
  return [
    '<section class="campaign-panel__section" aria-labelledby="activities-heading">',
    '<div class="campaign-panel__section-heading"><div><p class="eyebrow">Repeatable work</p><h3 id="activities-heading">Activities</h3></div><p>Seeded variants record your best result and enforce a cooldown.</p></div>',
    `<div class="activity-grid">${activities.map((activity) => [
      `<article class="activity-card" data-activity-id="${escapeHtml(activity.id)}"><header><h4>${escapeHtml(activity.name)}</h4><span>${activity.completions} clears</span></header>`,
      `<p>${escapeHtml(activity.description)}</p>`,
      `<small>${escapeHtml(activity.bestLabel ?? 'No recorded result')}${activity.cooldownLabel ? ` · ${escapeHtml(activity.cooldownLabel)}` : ''}</small>`,
      `<div>${activity.difficulties.map((difficulty) => `<button type="button" data-campaign-action="start-activity" data-activity-id="${escapeHtml(activity.id)}" data-difficulty-id="${escapeHtml(difficulty.id)}"${disabledAttributes(difficulty.available, difficulty.reason ?? 'Unavailable')}>${escapeHtml(difficulty.label)}</button>`).join('')}</div>`,
      '</article>',
    ].join('')).join('')}</div></section>`,
  ].join('');
}

function renderExploration(sets: readonly CollectibleSetModel[]): string {
  return [
    '<section class="campaign-panel__section" aria-labelledby="exploration-heading">',
    '<div class="campaign-panel__section-heading"><div><p class="eyebrow">City discoveries</p><h3 id="exploration-heading">Exploration</h3></div><p>Nearby markers appear as the city opens up.</p></div>',
    `<div class="collectible-grid">${sets.map((set) => {
      const percent = set.total > 0 ? Math.round(set.found / set.total * 100) : 0;
      return `<article data-collectible-set="${escapeHtml(set.id)}"><span>${set.completed ? 'Complete' : `${percent}%`}</span><h4>${escapeHtml(set.label)}</h4><p>${set.found} / ${set.total}</p><progress value="${set.found}" max="${set.total}" aria-label="${escapeHtml(set.label)} ${set.found} of ${set.total}"></progress></article>`;
    }).join('')}</div></section>`,
  ].join('');
}

function renderMissionLog(entries: readonly DialogueLogModel[]): string {
  return [
    '<section class="campaign-panel__section mission-log" aria-labelledby="mission-log-heading">',
    '<div class="campaign-panel__section-heading"><div><p class="eyebrow">Reviewable story</p><h3 id="mission-log-heading">Mission log</h3></div><p>Dialogue remains readable after it is skipped.</p></div>',
    entries.length === 0
      ? '<p class="mission-log__empty">Complete or begin a story job to record its dialogue.</p>'
      : `<ol>${entries.map((entry) => `<li data-dialogue-key="${escapeHtml(entry.key)}"><span>${escapeHtml(entry.missionTitle)}</span><p><strong>${escapeHtml(entry.speaker)}</strong> ${escapeHtml(entry.text)}</p></li>`).join('')}</ol>`,
    '</section>',
  ].join('');
}

function disabledAttributes(enabled: boolean, reason: string): string {
  return enabled ? '' : ` disabled aria-disabled="true" title="${escapeHtml(reason)}"`;
}

function formatProgress(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function isKnownId(value: string | undefined, known: ReadonlySet<string>): value is string {
  return value !== undefined && SAFE_ID.test(value) && known.has(value);
}

function isEndingChoice(value: string | undefined): value is 'rule' | 'expose' {
  return value === 'rule' || value === 'expose';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function hasClosest(value: EventTarget | null): value is Element {
  return value instanceof Element;
}

function hasDataset(value: Element | null): value is HTMLElement {
  return value instanceof HTMLElement;
}
