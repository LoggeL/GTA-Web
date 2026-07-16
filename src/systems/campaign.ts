import type {
  ContactId,
  MissionBranchReward,
  MissionDefinition,
  MissionId,
  MissionReward,
  ObjectiveDefinition,
} from '../data/types';
import type { EndingChoice } from '../core/state';

export type CampaignContactId = Exclude<ContactId, 'garage' | 'all-contacts'>;
export type CampaignMissionStatus = 'locked' | 'available' | 'active' | 'complete';

export interface CampaignMissionProgress {
  state: CampaignMissionStatus;
  checkpointId: string | null;
  completedObjectives: string[];
  choices: Record<string, string>;
}

export interface CampaignState {
  level: number;
  contacts: Record<CampaignContactId, number>;
  missions: Partial<Record<MissionId, CampaignMissionProgress>>;
  activeMissionId: MissionId | null;
  ending: EndingChoice | null;
  worldFlags: string[];
}

export type CampaignTransactionResult =
  | { success: true; state: CampaignState }
  | { success: false; state: CampaignState; reason: string };

export type MissionCompletionResult =
  | {
    success: true;
    state: CampaignState;
    rewards: MissionReward;
    branchReward: MissionBranchReward | null;
    ending: EndingChoice | null;
  }
  | { success: false; state: CampaignState; reason: string };

export interface MissionRestartState {
  missionId: MissionId;
  checkpointId: string | null;
  completedObjectives: readonly string[];
}

export function createCampaignState(
  definitions: readonly MissionDefinition[],
  level = 1,
): CampaignState {
  assertLevel(level);
  const missions: Partial<Record<MissionId, CampaignMissionProgress>> = {};
  for (const definition of definitions) {
    missions[definition.id] = {
      state: 'locked',
      checkpointId: null,
      completedObjectives: [],
      choices: {},
    };
  }
  return refreshMissionAvailability({
    level,
    contacts: { juno: 0, malik: 0, priya: 0 },
    missions,
    activeMissionId: null,
    ending: null,
    worldFlags: [],
  }, definitions);
}

export function refreshMissionAvailability(
  state: Readonly<CampaignState>,
  definitions: readonly MissionDefinition[],
): CampaignState {
  const next = cloneCampaign(state);
  for (const definition of definitions) {
    const progress = next.missions[definition.id] ?? createMissionProgress();
    if (progress.state === 'complete' || progress.state === 'active') {
      next.missions[definition.id] = progress;
      continue;
    }
    progress.state = meetsMissionGates(next, definition) ? 'available' : 'locked';
    next.missions[definition.id] = progress;
  }
  return next;
}

export function setCampaignLevel(
  state: Readonly<CampaignState>,
  level: number,
  definitions: readonly MissionDefinition[],
): CampaignState {
  assertLevel(level);
  return refreshMissionAvailability({ ...cloneCampaign(state), level }, definitions);
}

export function grantContactReputation(
  state: Readonly<CampaignState>,
  contact: CampaignContactId,
  amount: number,
  definitions: readonly MissionDefinition[],
  rewardMultiplier = 1,
): CampaignState {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(rewardMultiplier) || rewardMultiplier < 0) {
    throw new RangeError('reputation and multiplier must be non-negative and finite');
  }
  const next = cloneCampaign(state);
  next.contacts[contact] = Math.floor(next.contacts[contact] + amount * rewardMultiplier);
  return refreshMissionAvailability(next, definitions);
}

export function startMission(
  state: Readonly<CampaignState>,
  missionId: MissionId,
  definitions: readonly MissionDefinition[],
): CampaignTransactionResult {
  if (state.activeMissionId !== null) {
    return failure(state, `mission "${state.activeMissionId}" is already active`);
  }
  const definition = definitions.find((entry) => entry.id === missionId);
  if (!definition) {
    return failure(state, `unknown mission "${missionId}"`);
  }
  const refreshed = refreshMissionAvailability(state, definitions);
  const progress = refreshed.missions[missionId];
  if (progress?.state !== 'available') {
    return failure(state, `mission "${missionId}" is not available`);
  }

  const next = cloneCampaign(refreshed);
  const nextProgress = next.missions[missionId];
  if (!nextProgress) {
    return failure(state, `mission "${missionId}" has no progress record`);
  }
  nextProgress.state = 'active';
  nextProgress.checkpointId = definition.checkpoints.find((checkpoint) => checkpoint.afterObjectiveId === null)?.id
    ?? null;
  nextProgress.completedObjectives = [];
  nextProgress.choices = {};
  next.activeMissionId = missionId;
  return { success: true, state: next };
}

export function isObjectiveAvailable(
  state: Readonly<CampaignState>,
  definition: Readonly<MissionDefinition>,
  objectiveId: string,
): boolean {
  const progress = state.missions[definition.id];
  const objective = definition.objectives.find((entry) => entry.id === objectiveId);
  if (!progress || progress.state !== 'active' || !objective) {
    return false;
  }
  if (progress.completedObjectives.includes(objectiveId)) {
    return false;
  }
  if (!activationMatches(objective, progress.choices)) {
    return false;
  }
  const predecessors = definition.objectives.filter((entry) => entry.nextObjectiveIds.includes(objectiveId));
  return predecessors.length === 0
    || predecessors.some((entry) => progress.completedObjectives.includes(entry.id));
}

export function completeObjective(
  state: Readonly<CampaignState>,
  objectiveId: string,
  definitions: readonly MissionDefinition[],
  choice?: string,
): CampaignTransactionResult {
  const missionId = state.activeMissionId;
  if (!missionId) {
    return failure(state, 'no mission is active');
  }
  const definition = definitions.find((entry) => entry.id === missionId);
  const objective = definition?.objectives.find((entry) => entry.id === objectiveId);
  if (!definition || !objective) {
    return failure(state, `unknown objective "${objectiveId}" for active mission`);
  }
  if (!isObjectiveAvailable(state, definition, objectiveId)) {
    return failure(state, `objective "${objectiveId}" is not currently available`);
  }

  if (objective.completion.kind === 'choice-made') {
    if (choice === undefined || !objective.completion.choices.includes(choice)) {
      return failure(state, `objective "${objectiveId}" requires a valid choice`);
    }
  } else if (choice !== undefined) {
    return failure(state, `objective "${objectiveId}" does not accept a choice`);
  }

  const next = cloneCampaign(state);
  const progress = next.missions[missionId];
  if (!progress) {
    return failure(state, `mission "${missionId}" has no progress record`);
  }
  progress.completedObjectives.push(objectiveId);
  if (choice !== undefined) {
    progress.choices[objectiveId] = choice;
  }
  const checkpoint = definition.checkpoints.find((entry) => entry.afterObjectiveId === objectiveId);
  if (checkpoint) {
    progress.checkpointId = checkpoint.id;
  }
  return { success: true, state: next };
}

export function reachCheckpoint(
  state: Readonly<CampaignState>,
  checkpointId: string,
  definitions: readonly MissionDefinition[],
): CampaignTransactionResult {
  const missionId = state.activeMissionId;
  const definition = definitions.find((entry) => entry.id === missionId);
  const checkpoint = definition?.checkpoints.find((entry) => entry.id === checkpointId);
  if (!missionId || !definition || !checkpoint) {
    return failure(state, `checkpoint "${checkpointId}" does not belong to the active mission`);
  }
  const progress = state.missions[missionId];
  if (!progress || (checkpoint.afterObjectiveId !== null
    && !progress.completedObjectives.includes(checkpoint.afterObjectiveId))) {
    return failure(state, `checkpoint "${checkpointId}" has not been reached`);
  }
  const next = cloneCampaign(state);
  const nextProgress = next.missions[missionId];
  if (!nextProgress) {
    return failure(state, `mission "${missionId}" has no progress record`);
  }
  nextProgress.checkpointId = checkpointId;
  return { success: true, state: next };
}

export function canCompleteMission(
  state: Readonly<CampaignState>,
  definition: Readonly<MissionDefinition>,
): boolean {
  const progress = state.missions[definition.id];
  return Boolean(progress?.state === 'active' && definition.objectives.every((objective) => (
    objective.optional
    || !activationMatches(objective, progress.choices)
    || progress.completedObjectives.includes(objective.id)
  )));
}

export function completeMission(
  state: Readonly<CampaignState>,
  definitions: readonly MissionDefinition[],
): MissionCompletionResult {
  const missionId = state.activeMissionId;
  const definition = definitions.find((entry) => entry.id === missionId);
  if (!missionId || !definition) {
    return completionFailure(state, 'no valid mission is active');
  }
  if (!canCompleteMission(state, definition)) {
    return completionFailure(state, `mission "${missionId}" still has required objectives`);
  }

  const next = cloneCampaign(state);
  const progress = next.missions[missionId];
  if (!progress) {
    return completionFailure(state, `mission "${missionId}" has no progress record`);
  }
  progress.state = 'complete';
  next.activeMissionId = null;
  for (const [contact, amount] of Object.entries(definition.rewards.reputation)) {
    if (isCampaignContact(contact) && amount !== undefined) {
      next.contacts[contact] += amount;
    }
  }
  for (const flag of definition.rewards.unlockFlags) {
    if (!next.worldFlags.includes(flag)) {
      next.worldFlags.push(flag);
    }
  }
  let branchReward: MissionBranchReward | null = null;
  if (missionId === 'freehold') {
    const ending = Object.values(progress.choices).find(isEndingChoice);
    if (!ending) {
      return completionFailure(state, 'Freehold requires a Rule or Expose choice');
    }
    next.ending = ending;
    branchReward = definition.branchRewards?.find((reward) => reward.choice === ending) ?? null;
    if (branchReward && !next.worldFlags.includes(branchReward.unlockFlag)) {
      next.worldFlags.push(branchReward.unlockFlag);
    }
  }

  return {
    success: true,
    state: refreshMissionAvailability(next, definitions),
    rewards: definition.rewards,
    branchReward,
    ending: next.ending,
  };
}

export function restartState(state: Readonly<CampaignState>): MissionRestartState | null {
  const missionId = state.activeMissionId;
  if (!missionId) {
    return null;
  }
  const progress = state.missions[missionId];
  return progress ? {
    missionId,
    checkpointId: progress.checkpointId,
    completedObjectives: [...progress.completedObjectives],
  } : null;
}

export function abandonMission(
  state: Readonly<CampaignState>,
  definitions: readonly MissionDefinition[],
): CampaignTransactionResult {
  const missionId = state.activeMissionId;
  if (!missionId) {
    return failure(state, 'no mission is active');
  }
  const next = cloneCampaign(state);
  next.activeMissionId = null;
  next.missions[missionId] = createMissionProgress();
  return { success: true, state: refreshMissionAvailability(next, definitions) };
}

function meetsMissionGates(state: Readonly<CampaignState>, definition: MissionDefinition): boolean {
  if (state.level < definition.levelGate) {
    return false;
  }
  if (!definition.prerequisites.every((missionId) => state.missions[missionId]?.state === 'complete')) {
    return false;
  }
  return !definition.reputationGate
    || state.contacts[definition.reputationGate.contact] >= definition.reputationGate.minimum;
}

function activationMatches(
  objective: Readonly<ObjectiveDefinition>,
  choices: Readonly<Record<string, string>>,
): boolean {
  return !objective.activation
    || choices[objective.activation.choiceObjectiveId] === objective.activation.choice;
}

function createMissionProgress(): CampaignMissionProgress {
  return { state: 'locked', checkpointId: null, completedObjectives: [], choices: {} };
}

function cloneCampaign(state: Readonly<CampaignState>): CampaignState {
  const missions: Partial<Record<MissionId, CampaignMissionProgress>> = {};
  for (const [missionId, progress] of Object.entries(state.missions)) {
    missions[missionId as MissionId] = {
      ...progress,
      completedObjectives: [...progress.completedObjectives],
      choices: { ...progress.choices },
    };
  }
  return {
    level: state.level,
    contacts: { ...state.contacts },
    missions,
    activeMissionId: state.activeMissionId,
    ending: state.ending,
    worldFlags: [...state.worldFlags],
  };
}

function failure(state: Readonly<CampaignState>, reason: string): CampaignTransactionResult {
  return { success: false, state: cloneCampaign(state), reason };
}

function completionFailure(state: Readonly<CampaignState>, reason: string): MissionCompletionResult {
  return { success: false, state: cloneCampaign(state), reason };
}

function isCampaignContact(value: string): value is CampaignContactId {
  return value === 'juno' || value === 'malik' || value === 'priya';
}

function isEndingChoice(value: string): value is EndingChoice {
  return value === 'rule' || value === 'expose';
}

function assertLevel(level: number): void {
  if (!Number.isSafeInteger(level) || level < 1 || level > 20) {
    throw new RangeError('level must be an integer between 1 and 20');
  }
}
