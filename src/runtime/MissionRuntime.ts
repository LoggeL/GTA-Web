import { EventBus, type GameEventBus } from '../core/events';
import { MISSIONS } from '../data/missions';
import type {
  MissionBranchReward,
  MissionDefinition,
  MissionId,
  MissionReward,
  ObjectiveDefinition,
} from '../data/types';
import {
  abandonMission as abandonCampaignMission,
  canCompleteMission,
  completeMission as completeCampaignMission,
  completeObjective as completeCampaignObjective,
  createCampaignState,
  getCampaignCompletionSummary,
  getCampaignMissionLog,
  grantContactReputation,
  isObjectiveAvailable,
  reachCheckpoint as reachCampaignCheckpoint,
  refreshMissionAvailability,
  setCampaignLevel,
  startMission as startCampaignMission,
  type CampaignContactId,
  type CampaignCompletionSummary,
  type CampaignMissionLogEntry,
  type CampaignMissionProgress,
  type CampaignState,
} from '../systems/campaign';

export const MISSION_RUNTIME_SNAPSHOT_VERSION = 1 as const;

export type MissionFailureKind =
  | 'player-defeat'
  | 'critical-actor-lost'
  | 'objective-timeout'
  | 'scripted';

export type ObjectiveUpdate =
  | { kind: 'target'; targetId: string }
  | { kind: 'increment'; amount: number }
  | { kind: 'position'; distanceMeters: number }
  | { kind: 'elapsed'; seconds: number }
  | { kind: 'wanted'; level: number }
  | { kind: 'choice'; choice: string }
  | { kind: 'complete' };

export interface ObjectiveProgressSnapshot {
  current: number;
  target: number;
  completedTargetIds: string[];
  elapsedSeconds: number;
  timeoutElapsedSeconds: number;
  completed: boolean;
  skipped: boolean;
}

export interface MissionFailureSnapshot {
  kind: MissionFailureKind;
  reason: string;
  objectiveId: string | null;
}

export interface MissionCheckpointSnapshot {
  checkpointId: string | null;
  campaignProgress: CampaignMissionProgress;
  objectiveProgress: Record<string, ObjectiveProgressSnapshot>;
}

export interface ActiveMissionSnapshot {
  missionId: MissionId;
  status: 'active' | 'failed';
  failure: MissionFailureSnapshot | null;
  objectiveProgress: Record<string, ObjectiveProgressSnapshot>;
  checkpoint: MissionCheckpointSnapshot;
}

export interface MissionRuntimeSnapshotV1 {
  snapshotVersion: typeof MISSION_RUNTIME_SNAPSHOT_VERSION;
  campaign: CampaignState;
  active: ActiveMissionSnapshot | null;
}

export interface MissionEnvironmentState {
  readonly missionId: MissionId;
  readonly phase: 'apply' | 'cleanup';
  readonly timeOverride: NonNullable<MissionDefinition['timeOverride']> | null;
  readonly weatherOverride: NonNullable<MissionDefinition['weatherOverride']> | null;
  readonly cleanupFlags: readonly string[];
}

export interface MissionRuntimeEventMap {
  'mission:started': {
    missionId: MissionId;
    checkpointId: string | null;
    activeObjectiveIds: readonly string[];
  };
  'objective:progressed': {
    missionId: MissionId;
    objectiveId: string;
    current: number;
    target: number;
  };
  'objective:completed': { missionId: MissionId; objectiveId: string };
  'objective:failed': {
    missionId: MissionId;
    objectiveId: string;
    reason: string;
    fallback: ObjectiveDefinition['fallback']['mode'];
  };
  'checkpoint:reached': { missionId: MissionId; checkpointId: string };
  'mission:failed': {
    missionId: MissionId;
    kind: MissionFailureKind;
    reason: string;
    objectiveId: string | null;
  };
  'mission:retried': { missionId: MissionId; checkpointId: string | null };
  'mission:completed': {
    missionId: MissionId;
    rewards: MissionReward;
    branchReward: MissionBranchReward | null;
  };
  'mission:abandoned': { missionId: MissionId };
  'mission:environment': MissionEnvironmentState;
  'reward:granted': {
    missionId: MissionId;
    rewards: MissionReward;
    branchReward: MissionBranchReward | null;
  };
}

export type RuntimeActionResult =
  | { success: true }
  | { success: false; reason: string };

export function validateMissionRuntimeSnapshot(
  value: unknown,
  missions: readonly MissionDefinition[] = MISSIONS,
): RuntimeActionResult {
  const result = validateMissionSnapshot(value, missions);
  return result.success ? { success: true } : result;
}

export interface MissionRuntimeOptions {
  missions?: readonly MissionDefinition[];
  campaign?: CampaignState;
  events?: EventBus<MissionRuntimeEventMap>;
  gameEvents?: GameEventBus;
}

/** Stateful orchestration over pure campaign rules and authored mission definitions. */
export class MissionRuntime {
  public readonly events: EventBus<MissionRuntimeEventMap>;

  private readonly missions: readonly MissionDefinition[];
  private readonly gameEvents: GameEventBus | null;
  private campaign: CampaignState;
  private active: ActiveMissionSnapshot | null = null;

  public constructor(options: MissionRuntimeOptions = {}) {
    this.missions = options.missions ?? MISSIONS;
    this.events = options.events ?? new EventBus<MissionRuntimeEventMap>();
    this.gameEvents = options.gameEvents ?? null;
    this.campaign = options.campaign
      ? refreshMissionAvailability(cloneJson(options.campaign), this.missions)
      : createCampaignState(this.missions);
  }

  public get campaignState(): CampaignState {
    return cloneJson(this.campaign);
  }

  public get activeMission(): ActiveMissionSnapshot | null {
    return this.active ? cloneJson(this.active) : null;
  }

  public get activeMissionDefinition(): MissionDefinition | null {
    return this.active
      ? this.missions.find((mission) => mission.id === this.active?.missionId) ?? null
      : null;
  }

  public environmentState(): MissionEnvironmentState | null {
    const definition = this.activeMissionDefinition;
    return definition ? createEnvironmentState(definition, 'apply') : null;
  }

  public availableMissionIds(): readonly MissionId[] {
    return this.missions
      .filter((mission) => this.campaign.missions[mission.id]?.state === 'available')
      .map((mission) => mission.id);
  }

  public missionLog(): readonly CampaignMissionLogEntry[] {
    return getCampaignMissionLog(this.campaign, this.missions);
  }

  public completionSummary(): CampaignCompletionSummary {
    return getCampaignCompletionSummary(this.campaign, this.missions);
  }

  public activeObjectiveIds(): readonly string[] {
    const definition = this.activeMissionDefinition;
    if (!this.active || this.active.status !== 'active' || !definition) {
      return [];
    }
    return definition.objectives
      .filter((objective) => isObjectiveAvailable(this.campaign, definition, objective.id))
      .map((objective) => objective.id);
  }

  public setPlayerLevel(level: number): void {
    this.campaign = setCampaignLevel(this.campaign, level, this.missions);
  }

  public addContactReputation(
    contact: CampaignContactId,
    amount: number,
    multiplier = 1,
  ): void {
    this.campaign = grantContactReputation(
      this.campaign,
      contact,
      amount,
      this.missions,
      multiplier,
    );
  }

  public startMission(missionId: MissionId): RuntimeActionResult {
    const result = startCampaignMission(this.campaign, missionId, this.missions);
    if (!result.success) {
      return result;
    }
    const definition = this.missions.find((mission) => mission.id === missionId);
    const progress = result.state.missions[missionId];
    if (!definition || !progress) {
      return { success: false, reason: `mission registry is missing "${missionId}"` };
    }

    this.campaign = result.state;
    const objectiveProgress = Object.fromEntries(
      definition.objectives.map((objective) => [objective.id, createObjectiveProgress(objective)]),
    );
    this.active = {
      missionId,
      status: 'active',
      failure: null,
      objectiveProgress,
      checkpoint: {
        checkpointId: progress.checkpointId,
        campaignProgress: cloneJson(progress),
        objectiveProgress: cloneObjectiveProgress(objectiveProgress),
      },
    };
    const payload = {
      missionId,
      checkpointId: progress.checkpointId,
      activeObjectiveIds: this.activeObjectiveIds(),
    };
    this.events.emit('mission:started', payload);
    this.events.emit('mission:environment', createEnvironmentState(definition, 'apply'));
    this.gameEvents?.emit('mission:lifecycle', {
      missionId,
      state: 'started',
      checkpointId: progress.checkpointId,
    });
    return { success: true };
  }

  public updateObjective(objectiveId: string, update: Readonly<ObjectiveUpdate>): RuntimeActionResult {
    const context = this.requireActiveObjective(objectiveId);
    if (!context.success) {
      return context;
    }
    const { objective, progress } = context;
    let choice: string | undefined;
    let complete = false;

    switch (update.kind) {
      case 'target': {
        if (!objective.targetIds.includes(update.targetId)) {
          return { success: false, reason: `objective does not contain target "${update.targetId}"` };
        }
        if (!progress.completedTargetIds.includes(update.targetId)) {
          progress.completedTargetIds.push(update.targetId);
        }
        progress.current = Math.min(progress.target, progress.completedTargetIds.length);
        complete = objective.completion.kind === 'all-targets'
          && progress.completedTargetIds.length >= objective.targetIds.length;
        break;
      }
      case 'increment': {
        if (!Number.isFinite(update.amount) || update.amount < 0) {
          return { success: false, reason: 'objective increment must be non-negative and finite' };
        }
        if (objective.completion.kind !== 'target-count') {
          return { success: false, reason: 'increment updates require a target-count objective' };
        }
        progress.current = Math.min(progress.target, progress.current + update.amount);
        complete = progress.current >= progress.target;
        break;
      }
      case 'position': {
        if (!Number.isFinite(update.distanceMeters) || update.distanceMeters < 0) {
          return { success: false, reason: 'distanceMeters must be non-negative and finite' };
        }
        if (objective.completion.kind !== 'reach-destination') {
          return { success: false, reason: 'position updates require a reach-destination objective' };
        }
        complete = update.distanceMeters <= objective.completion.radiusMeters;
        progress.current = complete ? progress.target : 0;
        break;
      }
      case 'elapsed': {
        if (!Number.isFinite(update.seconds) || update.seconds < 0) {
          return { success: false, reason: 'elapsed seconds must be non-negative and finite' };
        }
        if (objective.completion.kind !== 'survive') {
          return { success: false, reason: 'elapsed updates require a survive objective' };
        }
        progress.elapsedSeconds = Math.min(progress.target, progress.elapsedSeconds + update.seconds);
        progress.current = progress.elapsedSeconds;
        complete = progress.current >= progress.target;
        break;
      }
      case 'wanted': {
        if (!Number.isSafeInteger(update.level) || update.level < 0 || update.level > 5) {
          return { success: false, reason: 'wanted level must be an integer between 0 and 5' };
        }
        if (objective.completion.kind !== 'lose-wanted') {
          return { success: false, reason: 'wanted updates require a lose-wanted objective' };
        }
        complete = update.level <= objective.completion.maximumLevel;
        progress.current = complete ? progress.target : 0;
        break;
      }
      case 'choice': {
        if (objective.completion.kind !== 'choice-made') {
          return { success: false, reason: 'choice updates require a choice objective' };
        }
        if (!objective.completion.choices.includes(update.choice)) {
          return { success: false, reason: `choice "${update.choice}" is not valid` };
        }
        choice = update.choice;
        progress.current = progress.target;
        complete = true;
        break;
      }
      case 'complete': {
        if (objective.completion.kind === 'choice-made') {
          return { success: false, reason: 'choice objectives require an explicit choice update' };
        }
        progress.current = progress.target;
        complete = true;
        break;
      }
    }

    this.emitObjectiveProgress(objectiveId, progress);
    return complete ? this.completeObjectiveInternal(objectiveId, choice) : { success: true };
  }

  public tick(deltaSeconds: number): RuntimeActionResult {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      return { success: false, reason: 'deltaSeconds must be non-negative and finite' };
    }
    if (!this.active || this.active.status !== 'active') {
      return { success: false, reason: 'no active mission can be ticked' };
    }
    const definition = this.activeMissionDefinition;
    if (!definition) {
      return { success: false, reason: 'active mission definition is missing' };
    }
    const activeObjectiveIds = [...this.activeObjectiveIds()];
    for (const objectiveId of activeObjectiveIds) {
      const objective = definition.objectives.find((entry) => entry.id === objectiveId);
      const progress = this.active?.objectiveProgress[objectiveId];
      if (!objective || !progress || progress.completed) {
        continue;
      }
      progress.timeoutElapsedSeconds += deltaSeconds;
      if (objective.completion.kind === 'survive') {
        const result = this.updateObjective(objectiveId, { kind: 'elapsed', seconds: deltaSeconds });
        if (!result.success || this.active?.status !== 'active') {
          return result;
        }
      }
      const current = this.active?.objectiveProgress[objectiveId];
      if (
        objective.timeoutSeconds !== undefined
        && current
        && !current.completed
        && current.timeoutElapsedSeconds >= objective.timeoutSeconds
      ) {
        const result = this.failObjective(objectiveId, 'Objective timer expired');
        if (!result.success || this.active?.status !== 'active') {
          return result;
        }
      }
    }
    return { success: true };
  }

  public failObjective(objectiveId: string, reason: string): RuntimeActionResult {
    const context = this.requireActiveObjective(objectiveId);
    if (!context.success) {
      return context;
    }
    const { objective } = context;
    this.events.emit('objective:failed', {
      missionId: this.active!.missionId,
      objectiveId,
      reason,
      fallback: objective.fallback.mode,
    });

    if (objective.fallback.mode === 'continue') {
      return { success: true };
    }
    if (objective.fallback.mode === 'restart-checkpoint') {
      return this.failMission('objective-timeout', reason, objectiveId);
    }

    const alternateId = objective.fallback.objectiveId;
    const definition = this.activeMissionDefinition;
    const path = alternateId && definition
      ? findObjectivePath(definition, objectiveId, alternateId)
      : null;
    if (!alternateId || !definition || !path) {
      return this.failMission('scripted', `${reason}; alternate objective is unavailable`, objectiveId);
    }
    const campaignProgress = this.campaign.missions[definition.id];
    if (!campaignProgress || !this.active) {
      return { success: false, reason: 'active campaign progress is missing' };
    }
    for (const skippedId of path.slice(0, -1)) {
      if (!campaignProgress.completedObjectives.includes(skippedId)) {
        campaignProgress.completedObjectives.push(skippedId);
      }
      const skippedProgress = this.active.objectiveProgress[skippedId];
      if (skippedProgress) {
        skippedProgress.current = skippedProgress.target;
        skippedProgress.completed = true;
        skippedProgress.skipped = true;
      }
    }
    const previousCheckpointId = campaignProgress.checkpointId;
    for (const checkpoint of definition.checkpoints) {
      if (
        checkpoint.afterObjectiveId !== null
        && campaignProgress.completedObjectives.includes(checkpoint.afterObjectiveId)
      ) {
        const reached = reachCampaignCheckpoint(this.campaign, checkpoint.id, this.missions);
        if (reached.success) {
          this.campaign = reached.state;
        }
      }
    }
    const checkpointId = this.campaign.missions[definition.id]?.checkpointId ?? null;
    if (checkpointId !== null && checkpointId !== previousCheckpointId) {
      this.captureCheckpoint(checkpointId);
      this.emitCheckpoint(checkpointId);
    }
    return isObjectiveAvailable(this.campaign, definition, alternateId)
      ? { success: true }
      : this.failMission('scripted', `${reason}; alternate objective could not activate`, objectiveId);
  }

  public reachCheckpoint(checkpointId: string): RuntimeActionResult {
    if (!this.active || this.active.status !== 'active') {
      return { success: false, reason: 'no mission is active' };
    }
    const result = reachCampaignCheckpoint(this.campaign, checkpointId, this.missions);
    if (!result.success) {
      return result;
    }
    this.campaign = result.state;
    this.captureCheckpoint(checkpointId);
    this.emitCheckpoint(checkpointId);
    return { success: true };
  }

  public failMission(
    kind: MissionFailureKind,
    reason: string,
    objectiveId: string | null = null,
  ): RuntimeActionResult {
    if (!this.active || this.active.status !== 'active') {
      return { success: false, reason: 'no active mission can fail' };
    }
    this.active.status = 'failed';
    this.active.failure = { kind, reason, objectiveId };
    const missionId = this.active.missionId;
    this.events.emit('mission:failed', { missionId, kind, reason, objectiveId });
    this.gameEvents?.emit('mission:lifecycle', {
      missionId,
      state: 'failed',
      checkpointId: this.active.checkpoint.checkpointId,
    });
    return { success: true };
  }

  public retryMission(): RuntimeActionResult {
    if (!this.active || this.active.status !== 'failed') {
      return { success: false, reason: 'no failed mission can be retried' };
    }
    const { checkpoint, missionId } = this.active;
    this.campaign.missions[missionId] = cloneJson(checkpoint.campaignProgress);
    this.campaign.activeMissionId = missionId;
    this.active.objectiveProgress = cloneObjectiveProgress(checkpoint.objectiveProgress);
    this.active.status = 'active';
    this.active.failure = null;
    this.events.emit('mission:retried', {
      missionId,
      checkpointId: checkpoint.checkpointId,
    });
    this.gameEvents?.emit('mission:lifecycle', {
      missionId,
      state: 'checkpoint',
      checkpointId: checkpoint.checkpointId,
    });
    return { success: true };
  }

  public succeedMission(): RuntimeActionResult {
    if (!this.active || this.active.status !== 'active') {
      return { success: false, reason: 'no active mission can complete' };
    }
    const definition = this.activeMissionDefinition;
    if (!definition || !canCompleteMission(this.campaign, definition)) {
      return { success: false, reason: 'required mission objectives are incomplete' };
    }
    const missionId = this.active.missionId;
    const previousContacts = { ...this.campaign.contacts };
    const result = completeCampaignMission(this.campaign, this.missions);
    if (!result.success) {
      return result;
    }
    this.campaign = result.state;
    this.active = null;
    const payload = {
      missionId,
      rewards: result.rewards,
      branchReward: result.branchReward,
    };
    this.events.emit('reward:granted', payload);
    this.events.emit('mission:completed', payload);
    this.events.emit('mission:environment', createEnvironmentState(definition, 'cleanup'));
    this.gameEvents?.emit('mission:lifecycle', {
      missionId,
      state: 'completed',
      checkpointId: null,
    });
    for (const contact of ['juno', 'malik', 'priya'] as const) {
      const amount = this.campaign.contacts[contact] - previousContacts[contact];
      if (amount > 0) {
        this.gameEvents?.emit('progression:reputation', {
          contactId: contact,
          amount,
          total: this.campaign.contacts[contact],
        });
      }
    }
    for (const item of result.rewards.items) {
      this.gameEvents?.emit('inventory:transaction', {
        itemId: item.itemId,
        quantity: item.quantity,
        source: missionId,
        destination: 'backpack',
        reason: 'loot',
      });
    }
    return { success: true };
  }

  public abandonMission(): RuntimeActionResult {
    if (!this.active) {
      return { success: false, reason: 'no mission is active' };
    }
    const missionId = this.active.missionId;
    const definition = this.activeMissionDefinition;
    const result = abandonCampaignMission(this.campaign, this.missions);
    if (!result.success) {
      return result;
    }
    this.campaign = result.state;
    this.active = null;
    this.events.emit('mission:abandoned', { missionId });
    if (definition) {
      this.events.emit('mission:environment', createEnvironmentState(definition, 'cleanup'));
    }
    this.gameEvents?.emit('mission:lifecycle', {
      missionId,
      state: 'abandoned',
      checkpointId: null,
    });
    return { success: true };
  }

  public snapshot(): MissionRuntimeSnapshotV1 {
    return cloneJson({
      snapshotVersion: MISSION_RUNTIME_SNAPSHOT_VERSION,
      campaign: this.campaign,
      active: this.active,
    });
  }

  public restore(value: unknown): RuntimeActionResult {
    const validation = validateMissionSnapshot(value, this.missions);
    if (!validation.success) {
      return validation;
    }
    this.campaign = cloneJson(validation.snapshot.campaign);
    this.active = validation.snapshot.active ? cloneJson(validation.snapshot.active) : null;
    const definition = this.activeMissionDefinition;
    if (definition) {
      this.events.emit('mission:environment', createEnvironmentState(definition, 'apply'));
    }
    return { success: true };
  }

  private requireActiveObjective(objectiveId: string):
    | { success: true; objective: ObjectiveDefinition; progress: ObjectiveProgressSnapshot }
    | { success: false; reason: string } {
    if (!this.active || this.active.status !== 'active') {
      return { success: false, reason: 'no active mission accepts objective progress' };
    }
    const definition = this.activeMissionDefinition;
    const objective = definition?.objectives.find((entry) => entry.id === objectiveId);
    const progress = this.active.objectiveProgress[objectiveId];
    if (!definition || !objective || !progress) {
      return { success: false, reason: `unknown objective "${objectiveId}"` };
    }
    if (!isObjectiveAvailable(this.campaign, definition, objectiveId)) {
      return { success: false, reason: `objective "${objectiveId}" is not active` };
    }
    return { success: true, objective, progress };
  }

  private completeObjectiveInternal(
    objectiveId: string,
    choice?: string,
    resolveComposites = true,
  ): RuntimeActionResult {
    if (!this.active) {
      return { success: false, reason: 'no mission is active' };
    }
    const missionId = this.active.missionId;
    const previousCheckpoint = this.campaign.missions[missionId]?.checkpointId ?? null;
    const result = completeCampaignObjective(this.campaign, objectiveId, this.missions, choice);
    if (!result.success) {
      return result;
    }
    this.campaign = result.state;
    const progress = this.active.objectiveProgress[objectiveId];
    if (progress) {
      progress.current = progress.target;
      progress.completed = true;
    }
    this.events.emit('objective:completed', { missionId, objectiveId });
    const checkpointId = this.campaign.missions[missionId]?.checkpointId ?? null;
    if (checkpointId !== null && checkpointId !== previousCheckpoint) {
      this.captureCheckpoint(checkpointId);
      this.emitCheckpoint(checkpointId);
    }
    if (resolveComposites) {
      return this.resolveCompositeObjectives();
    }
    return { success: true };
  }

  private resolveCompositeObjectives(): RuntimeActionResult {
    const definition = this.activeMissionDefinition;
    if (!definition || !this.active) {
      return { success: true };
    }
    let resolved = true;
    while (resolved) {
      resolved = false;
      const completed = this.campaign.missions[definition.id]?.completedObjectives ?? [];
      const composite = definition.objectives.find((objective) => (
        objective.completion.kind === 'composite'
        && isObjectiveAvailable(this.campaign, definition, objective.id)
        && objective.completion.requiredObjectiveIds.every((id) => completed.includes(id))
      ));
      if (composite) {
        const progress = this.active.objectiveProgress[composite.id];
        if (progress) {
          progress.current = progress.target;
          this.emitObjectiveProgress(composite.id, progress);
        }
        const result = this.completeObjectiveInternal(composite.id, undefined, false);
        if (!result.success) {
          return result;
        }
        resolved = true;
      }
    }
    return { success: true };
  }

  private captureCheckpoint(checkpointId: string): void {
    if (!this.active) {
      return;
    }
    const progress = this.campaign.missions[this.active.missionId];
    if (!progress) {
      return;
    }
    this.active.checkpoint = {
      checkpointId,
      campaignProgress: cloneJson(progress),
      objectiveProgress: cloneObjectiveProgress(this.active.objectiveProgress),
    };
  }

  private emitObjectiveProgress(
    objectiveId: string,
    progress: Readonly<ObjectiveProgressSnapshot>,
  ): void {
    if (!this.active) {
      return;
    }
    const payload = {
      missionId: this.active.missionId,
      objectiveId,
      current: progress.current,
      target: progress.target,
    };
    this.events.emit('objective:progressed', payload);
    this.gameEvents?.emit('objective:progress', payload);
  }

  private emitCheckpoint(checkpointId: string): void {
    if (!this.active) {
      return;
    }
    const payload = { missionId: this.active.missionId, checkpointId };
    this.events.emit('checkpoint:reached', payload);
    this.gameEvents?.emit('mission:lifecycle', {
      ...payload,
      state: 'checkpoint',
    });
  }
}

function createEnvironmentState(
  definition: Readonly<MissionDefinition>,
  phase: MissionEnvironmentState['phase'],
): MissionEnvironmentState {
  return {
    missionId: definition.id,
    phase,
    timeOverride: definition.timeOverride ?? null,
    weatherOverride: definition.weatherOverride ?? null,
    cleanupFlags: [...definition.cleanupFlags],
  };
}

function createObjectiveProgress(objective: Readonly<ObjectiveDefinition>): ObjectiveProgressSnapshot {
  let target = 1;
  switch (objective.completion.kind) {
    case 'all-targets':
      target = Math.max(1, objective.targetIds.length);
      break;
    case 'target-count':
      target = objective.completion.required;
      break;
    case 'survive':
      target = objective.completion.durationSeconds;
      break;
    case 'composite':
      target = Math.max(1, objective.completion.requiredObjectiveIds.length);
      break;
    case 'reach-destination':
    case 'lose-wanted':
    case 'choice-made':
      target = 1;
      break;
  }
  return {
    current: 0,
    target,
    completedTargetIds: [],
    elapsedSeconds: 0,
    timeoutElapsedSeconds: 0,
    completed: false,
    skipped: false,
  };
}

function findObjectivePath(
  definition: Readonly<MissionDefinition>,
  startId: string,
  targetId: string,
): readonly string[] | null {
  const queue: string[][] = [[startId]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift();
    const currentId = path?.at(-1);
    if (!path || !currentId || visited.has(currentId)) {
      continue;
    }
    if (currentId === targetId) {
      return path;
    }
    visited.add(currentId);
    const objective = definition.objectives.find((entry) => entry.id === currentId);
    for (const nextId of objective?.nextObjectiveIds ?? []) {
      queue.push([...path, nextId]);
    }
  }
  return null;
}

function cloneObjectiveProgress(
  value: Readonly<Record<string, ObjectiveProgressSnapshot>>,
): Record<string, ObjectiveProgressSnapshot> {
  return Object.fromEntries(Object.entries(value).map(([id, progress]) => [id, {
    ...progress,
    completedTargetIds: [...progress.completedTargetIds],
  }]));
}

function validateMissionSnapshot(
  value: unknown,
  missions: readonly MissionDefinition[],
):
  | { success: true; snapshot: MissionRuntimeSnapshotV1 }
  | { success: false; reason: string } {
  if (!isRecord(value) || value.snapshotVersion !== MISSION_RUNTIME_SNAPSHOT_VERSION) {
    return { success: false, reason: 'mission snapshot version is not supported' };
  }
  if (!isRecord(value.campaign)) {
    return { success: false, reason: 'mission snapshot campaign is missing' };
  }
  const campaignValidation = validateCampaignSnapshot(value.campaign, missions);
  if (!campaignValidation.success) {
    return campaignValidation;
  }
  const campaign = campaignValidation.campaign;
  if (value.active === null) {
    if (campaign.activeMissionId !== null) {
      return { success: false, reason: 'mission snapshot active state is inconsistent' };
    }
    return { success: true, snapshot: value as unknown as MissionRuntimeSnapshotV1 };
  }
  if (!isRecord(value.active) || typeof value.active.missionId !== 'string') {
    return { success: false, reason: 'mission snapshot active mission is invalid' };
  }
  const active = value.active;
  const definition = missions.find((mission) => mission.id === active.missionId);
  if (!definition || campaign.activeMissionId !== definition.id) {
    return { success: false, reason: 'mission snapshot active mission is inconsistent' };
  }
  if (active.status !== 'active' && active.status !== 'failed') {
    return { success: false, reason: 'mission snapshot active status is invalid' };
  }
  if (
    (active.status === 'active' && active.failure !== null)
    || (active.status === 'failed' && !isMissionFailureSnapshot(active.failure, definition))
  ) {
    return { success: false, reason: 'mission snapshot failure state is invalid' };
  }
  if (!isRecord(active.objectiveProgress)) {
    return { success: false, reason: 'mission snapshot objective progress is missing' };
  }
  const objectiveProgress = active.objectiveProgress;
  const objectiveIds = new Set(definition.objectives.map((objective) => objective.id));
  const progressIds = Object.keys(objectiveProgress);
  if (
    progressIds.length !== objectiveIds.size
    || progressIds.some((id) => !objectiveIds.has(id))
    || definition.objectives.some((objective) => (
      !isObjectiveProgressSnapshot(objectiveProgress[objective.id], objective)
    ))
  ) {
    return { success: false, reason: 'mission snapshot objective progress is invalid' };
  }
  const campaignProgress = campaign.missions[definition.id];
  if (!campaignProgress || definition.objectives.some((objective) => (
    campaignProgress.completedObjectives.includes(objective.id)
      !== Boolean((objectiveProgress[objective.id] as ObjectiveProgressSnapshot | undefined)?.completed)
  ))) {
    return { success: false, reason: 'mission snapshot objective completion is inconsistent' };
  }
  if (!isRecord(active.checkpoint)) {
    return { success: false, reason: 'mission snapshot checkpoint is missing' };
  }
  const checkpoint = active.checkpoint;
  const checkpointId = checkpoint.checkpointId;
  if (checkpointId !== null
    && (typeof checkpointId !== 'string'
      || !definition.checkpoints.some((checkpoint) => checkpoint.id === checkpointId))) {
    return { success: false, reason: 'mission snapshot checkpoint is invalid' };
  }
  if (!isRecord(checkpoint.campaignProgress) || !isRecord(checkpoint.objectiveProgress)) {
    return { success: false, reason: 'mission snapshot checkpoint progress is invalid' };
  }
  const checkpointObjectiveProgress = checkpoint.objectiveProgress;
  const checkpointProgressIds = Object.keys(checkpointObjectiveProgress);
  const checkpointCampaignProgress = checkpoint.campaignProgress;
  if (
    checkpointProgressIds.length !== objectiveIds.size
    || checkpointProgressIds.some((id) => !objectiveIds.has(id))
    || !isCampaignMissionProgress(checkpointCampaignProgress, definition, 'active')
    || checkpointCampaignProgress.checkpointId !== checkpointId
    || checkpointCampaignProgress.completedObjectives.some((id) => (
      !campaignProgress.completedObjectives.includes(id)
    ))
    || definition.objectives.some((objective) => (
      !isObjectiveProgressSnapshot(checkpointObjectiveProgress[objective.id], objective)
      || checkpointCampaignProgress.completedObjectives.includes(objective.id)
        !== Boolean((checkpointObjectiveProgress[objective.id] as ObjectiveProgressSnapshot | undefined)?.completed)
    ))
  ) {
    return { success: false, reason: 'mission snapshot checkpoint progress is invalid' };
  }
  return { success: true, snapshot: value as unknown as MissionRuntimeSnapshotV1 };
}

function validateCampaignSnapshot(
  value: Record<string, unknown>,
  missions: readonly MissionDefinition[],
):
  | { success: true; campaign: CampaignState }
  | { success: false; reason: string } {
  if (!Number.isSafeInteger(value.level) || (value.level as number) < 1 || (value.level as number) > 20) {
    return { success: false, reason: 'mission snapshot campaign level is invalid' };
  }
  if (!isRecord(value.contacts) || !isRecord(value.missions)) {
    return { success: false, reason: 'mission snapshot campaign records are invalid' };
  }
  for (const contact of ['juno', 'malik', 'priya'] as const) {
    const reputation = value.contacts[contact];
    if (!Number.isSafeInteger(reputation) || (reputation as number) < 0) {
      return { success: false, reason: 'mission snapshot contact reputation is invalid' };
    }
  }
  if (
    Object.keys(value.contacts).some((contact) => (
      contact !== 'juno' && contact !== 'malik' && contact !== 'priya'
    ))
  ) {
    return { success: false, reason: 'mission snapshot contact reputation is invalid' };
  }
  const missionIds = new Set(missions.map((mission) => mission.id));
  const progressIds = Object.keys(value.missions);
  if (
    progressIds.length !== missionIds.size
    || progressIds.some((missionId) => !missionIds.has(missionId as MissionId))
  ) {
    return { success: false, reason: 'mission snapshot campaign mission records are invalid' };
  }
  if (
    value.activeMissionId !== null
    && (typeof value.activeMissionId !== 'string' || !missionIds.has(value.activeMissionId as MissionId))
  ) {
    return { success: false, reason: 'mission snapshot references an unknown active mission' };
  }
  if (value.ending !== null && value.ending !== 'rule' && value.ending !== 'expose') {
    return { success: false, reason: 'mission snapshot campaign ending is invalid' };
  }
  if (
    !Array.isArray(value.worldFlags)
    || value.worldFlags.some((flag) => typeof flag !== 'string' || flag.length === 0)
    || new Set(value.worldFlags).size !== value.worldFlags.length
  ) {
    return { success: false, reason: 'mission snapshot campaign world flags are invalid' };
  }
  for (const definition of missions) {
    const progress = value.missions[definition.id];
    if (!isCampaignMissionProgress(progress, definition)) {
      return { success: false, reason: `mission snapshot progress for "${definition.id}" is invalid` };
    }
    if ((progress.state === 'active') !== (value.activeMissionId === definition.id)) {
      return { success: false, reason: 'mission snapshot active campaign progress is inconsistent' };
    }
  }

  const campaign = value as unknown as CampaignState;
  const refreshed = refreshMissionAvailability(campaign, missions);
  for (const definition of missions) {
    const currentState = campaign.missions[definition.id]?.state;
    if (
      currentState !== 'active'
      && currentState !== 'complete'
      && refreshed.missions[definition.id]?.state !== currentState
    ) {
      return { success: false, reason: `mission snapshot availability for "${definition.id}" is inconsistent` };
    }
  }
  const finale = missions.find((mission) => mission.id === 'freehold');
  const finaleProgress = finale ? campaign.missions.freehold : undefined;
  const finaleChoice = finaleProgress
    ? Object.values(finaleProgress.choices).find((choice) => choice === 'rule' || choice === 'expose')
    : undefined;
  if (
    (campaign.ending !== null && (finaleProgress?.state !== 'complete' || finaleChoice !== campaign.ending))
    || (finaleProgress?.state === 'complete' && campaign.ending === null)
  ) {
    return { success: false, reason: 'mission snapshot finale ending is inconsistent' };
  }
  return { success: true, campaign };
}

function isCampaignMissionProgress(
  value: unknown,
  definition: Readonly<MissionDefinition>,
  expectedState?: CampaignMissionProgress['state'],
): value is CampaignMissionProgress {
  if (!isRecord(value)) {
    return false;
  }
  if (
    (value.state !== 'locked'
      && value.state !== 'available'
      && value.state !== 'active'
      && value.state !== 'complete')
    || (expectedState !== undefined && value.state !== expectedState)
    || !Array.isArray(value.completedObjectives)
    || value.completedObjectives.some((objectiveId) => typeof objectiveId !== 'string')
    || new Set(value.completedObjectives).size !== value.completedObjectives.length
    || !isRecord(value.choices)
  ) {
    return false;
  }
  const objectiveIds = new Set(definition.objectives.map((objective) => objective.id));
  const completedObjectives = value.completedObjectives as string[];
  if (completedObjectives.some((objectiveId) => !objectiveIds.has(objectiveId))) {
    return false;
  }
  if (
    value.checkpointId !== null
    && (typeof value.checkpointId !== 'string'
      || !definition.checkpoints.some((checkpoint) => checkpoint.id === value.checkpointId))
  ) {
    return false;
  }
  const checkpoint = definition.checkpoints.find((entry) => entry.id === value.checkpointId);
  if (
    checkpoint?.afterObjectiveId !== null
    && checkpoint?.afterObjectiveId !== undefined
    && !completedObjectives.includes(checkpoint.afterObjectiveId)
  ) {
    return false;
  }
  for (const [objectiveId, choice] of Object.entries(value.choices)) {
    const objective = definition.objectives.find((entry) => entry.id === objectiveId);
    if (
      typeof choice !== 'string'
      || objective?.completion.kind !== 'choice-made'
      || !objective.completion.choices.includes(choice)
      || !completedObjectives.includes(objectiveId)
    ) {
      return false;
    }
  }
  const seen = new Set<string>();
  for (const objectiveId of completedObjectives) {
    const objective = definition.objectives.find((entry) => entry.id === objectiveId);
    if (!objective || !objectiveActivationMatches(objective, value.choices as Record<string, string>)) {
      return false;
    }
    const predecessors = definition.objectives.filter((entry) => entry.nextObjectiveIds.includes(objectiveId));
    if (predecessors.length > 0 && !predecessors.some((entry) => seen.has(entry.id))) {
      return false;
    }
    seen.add(objectiveId);
  }
  if (
    (value.state === 'locked' || value.state === 'available')
    && (value.checkpointId !== null || completedObjectives.length > 0 || Object.keys(value.choices).length > 0)
  ) {
    return false;
  }
  if (value.state === 'complete' && definition.objectives.some((objective) => (
    !objective.optional
    && objectiveActivationMatches(objective, value.choices as Record<string, string>)
    && !completedObjectives.includes(objective.id)
  ))) {
    return false;
  }
  return true;
}

function objectiveActivationMatches(
  objective: Readonly<ObjectiveDefinition>,
  choices: Readonly<Record<string, string>>,
): boolean {
  return !objective.activation
    || choices[objective.activation.choiceObjectiveId] === objective.activation.choice;
}

function isMissionFailureSnapshot(
  value: unknown,
  definition: Readonly<MissionDefinition>,
): value is MissionFailureSnapshot {
  return isRecord(value)
    && (value.kind === 'player-defeat'
      || value.kind === 'critical-actor-lost'
      || value.kind === 'objective-timeout'
      || value.kind === 'scripted')
    && typeof value.reason === 'string'
    && (value.objectiveId === null
      || (typeof value.objectiveId === 'string'
        && definition.objectives.some((objective) => objective.id === value.objectiveId)));
}

function isObjectiveProgressSnapshot(
  value: unknown,
  objective: Readonly<ObjectiveDefinition>,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const expectedTarget = createObjectiveProgress(objective).target;
  if (
    typeof value.current !== 'number'
    || !Number.isFinite(value.current)
    || value.current < 0
    || value.current > expectedTarget
    || value.target !== expectedTarget
    || typeof value.elapsedSeconds !== 'number'
    || !Number.isFinite(value.elapsedSeconds)
    || value.elapsedSeconds < 0
    || value.elapsedSeconds > expectedTarget
    || typeof value.timeoutElapsedSeconds !== 'number'
    || !Number.isFinite(value.timeoutElapsedSeconds)
    || value.timeoutElapsedSeconds < 0
    || typeof value.completed !== 'boolean'
    || typeof value.skipped !== 'boolean'
    || !Array.isArray(value.completedTargetIds)
    || value.completedTargetIds.some((targetId) => (
      typeof targetId !== 'string' || !objective.targetIds.includes(targetId)
    ))
    || new Set(value.completedTargetIds).size !== value.completedTargetIds.length
    || (value.skipped && !value.completed)
  ) {
    return false;
  }
  if (value.completed && value.current !== expectedTarget) {
    return false;
  }
  if (
    !value.skipped
    && objective.completion.kind === 'all-targets'
    && value.current !== value.completedTargetIds.length
  ) {
    return false;
  }
  return objective.completion.kind !== 'survive' || value.current === value.elapsedSeconds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}
