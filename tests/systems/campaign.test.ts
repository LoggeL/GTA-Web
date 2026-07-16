import { describe, expect, it } from 'vitest';

import type { MissionDefinition, MissionId } from '../../src/data/types';
import {
  abandonMission,
  completeMission,
  completeObjective,
  createCampaignState,
  grantContactReputation,
  isObjectiveAvailable,
  reachCheckpoint,
  restartState,
  setCampaignLevel,
  startMission,
  type CampaignState,
} from '../../src/systems/campaign';

function simpleMission(
  id: MissionId,
  prerequisites: readonly MissionId[],
  reputationMinimum: number | null,
  levelGate: number,
  reputationReward: number,
): MissionDefinition {
  const objectiveId = `${id}:objective`;
  return {
    id,
    number: 1,
    title: id,
    subtitle: '',
    contact: id === 'past-due' ? 'garage' : 'juno',
    district: 'arroyo-heights',
    prerequisites,
    ...(reputationMinimum === null ? {} : {
      reputationGate: { contact: 'juno' as const, minimum: reputationMinimum },
    }),
    levelGate,
    startTrigger: { kind: 'world-marker', targetId: `${id}:start` },
    objectives: [{
      id: objectiveId,
      type: 'reach',
      title: 'Objective',
      description: '',
      targetIds: ['target'],
      completion: { kind: 'all-targets' },
      optional: false,
      fallback: { mode: 'restart-checkpoint', description: '' },
      nextObjectiveIds: [],
    }],
    checkpoints: [
      {
        id: `${id}:start`, label: 'Start', afterObjectiveId: null,
        respawn: { district: 'arroyo-heights', x: 0, y: 0, z: 0 },
        restore: { healthPercent: 100, armorPercent: 100, refillMissionItems: true },
      },
      {
        id: `${id}:complete`, label: 'Complete', afterObjectiveId: objectiveId,
        respawn: { district: 'arroyo-heights', x: 1, y: 0, z: 1 },
        restore: { healthPercent: 100, armorPercent: 100, refillMissionItems: true },
      },
    ],
    rewards: {
      id: `${id}:reward`,
      cash: 100,
      xp: 100,
      reputation: { juno: reputationReward },
      items: [],
      unlockFlags: [`${id}:complete-flag`],
    },
    dialogueKeys: [],
    failRestart: {
      onPlayerDefeat: 'latest-checkpoint',
      onCriticalActorLost: 'latest-checkpoint',
      onAbandon: 'mission-start',
    },
    cleanupFlags: [],
  };
}

const FREEHOLD: MissionDefinition = {
  ...simpleMission('freehold', ['rolling-stock'], null, 2, 0),
  branchRewards: [
    { choice: 'rule', unlockFlag: 'ending-rule', modifiers: [{ stat: 'propertyIncome', percent: 20 }] },
    { choice: 'expose', unlockFlag: 'ending-expose', modifiers: [{ stat: 'wantedSearchDuration', percent: -20 }] },
  ],
  objectives: [
    {
      id: 'freehold:choice', type: 'choice', title: 'Choose', description: '', targetIds: [],
      completion: { kind: 'choice-made', choices: ['rule', 'expose'] }, optional: false,
      fallback: { mode: 'restart-checkpoint', description: '' },
      nextObjectiveIds: ['freehold:rule', 'freehold:expose'],
    },
    {
      id: 'freehold:rule', type: 'stealth-hack', title: 'Rule', description: '', targetIds: ['rule'],
      completion: { kind: 'all-targets' }, optional: false,
      fallback: { mode: 'restart-checkpoint', description: '' }, nextObjectiveIds: ['freehold:escape'],
      activation: { choiceObjectiveId: 'freehold:choice', choice: 'rule' },
    },
    {
      id: 'freehold:expose', type: 'stealth-hack', title: 'Expose', description: '', targetIds: ['expose'],
      completion: { kind: 'all-targets' }, optional: false,
      fallback: { mode: 'restart-checkpoint', description: '' }, nextObjectiveIds: ['freehold:escape'],
      activation: { choiceObjectiveId: 'freehold:choice', choice: 'expose' },
    },
    {
      id: 'freehold:escape', type: 'evade', title: 'Escape', description: '', targetIds: ['exit'],
      completion: { kind: 'all-targets' }, optional: false,
      fallback: { mode: 'restart-checkpoint', description: '' }, nextObjectiveIds: [],
    },
  ],
  checkpoints: [{
    id: 'freehold:start', label: 'Start', afterObjectiveId: null,
    respawn: { district: 'alta-vista', x: 0, y: 0, z: 0 },
    restore: { healthPercent: 100, armorPercent: 100, refillMissionItems: true },
  }],
};

const MISSIONS: readonly MissionDefinition[] = [
  simpleMission('past-due', [], null, 1, 2),
  simpleMission('coastline-burn', ['past-due'], 2, 1, 3),
  simpleMission('rolling-stock', ['coastline-burn'], 5, 2, 1),
  FREEHOLD,
];

function finishSimple(state: CampaignState, missionId: MissionId): CampaignState {
  const started = startMission(state, missionId, MISSIONS);
  if (!started.success) throw new Error(started.reason);
  const objective = completeObjective(started.state, `${missionId}:objective`, MISSIONS);
  if (!objective.success) throw new Error(objective.reason);
  const completed = completeMission(objective.state, MISSIONS);
  if (!completed.success) throw new Error(completed.reason);
  return completed.state;
}

function stateBeforeFinale(): CampaignState {
  let state = createCampaignState(MISSIONS);
  state = finishSimple(state, 'past-due');
  state = finishSimple(state, 'coastline-burn');
  state = setCampaignLevel(state, 2, MISSIONS);
  state = finishSimple(state, 'rolling-stock');
  return state;
}

describe('campaign state machine', () => {
  it('derives unlocks from prerequisites, reputation, and level gates', () => {
    let state = createCampaignState(MISSIONS);
    expect(state.missions['past-due']?.state).toBe('available');
    expect(state.missions['coastline-burn']?.state).toBe('locked');
    expect(startMission(state, 'coastline-burn', MISSIONS).success).toBe(false);

    state = finishSimple(state, 'past-due');
    expect(state.contacts.juno).toBe(2);
    expect(state.missions['coastline-burn']?.state).toBe('available');
    state = finishSimple(state, 'coastline-burn');
    expect(state.contacts.juno).toBe(5);
    expect(state.missions['rolling-stock']?.state).toBe('locked');
    state = setCampaignLevel(state, 2, MISSIONS);
    expect(state.missions['rolling-stock']?.state).toBe('available');
  });

  it('tracks objective ordering, automatic checkpoints, rewards, and restart state', () => {
    const initial = createCampaignState(MISSIONS);
    const started = startMission(initial, 'past-due', MISSIONS);
    expect(started.success).toBe(true);
    if (!started.success) return;
    expect(restartState(started.state)).toEqual({
      missionId: 'past-due',
      checkpointId: 'past-due:start',
      completedObjectives: [],
    });
    expect(completeMission(started.state, MISSIONS).success).toBe(false);
    expect(reachCheckpoint(started.state, 'past-due:complete', MISSIONS).success).toBe(false);

    const objective = completeObjective(started.state, 'past-due:objective', MISSIONS);
    expect(objective.success).toBe(true);
    if (!objective.success) return;
    expect(objective.state.missions['past-due']?.checkpointId).toBe('past-due:complete');
    const completion = completeMission(objective.state, MISSIONS);
    expect(completion.success).toBe(true);
    if (completion.success) {
      expect(completion.rewards.cash).toBe(100);
      expect(completion.state.worldFlags).toContain('past-due:complete-flag');
    }
    expect(initial.missions['past-due']?.state).toBe('available');
  });

  it('applies deterministic contact reputation multipliers', () => {
    const initial = createCampaignState(MISSIONS);
    const state = grantContactReputation(initial, 'priya', 5, MISSIONS, 1.2);
    expect(state.contacts.priya).toBe(6);
    expect(initial.contacts.priya).toBe(0);
  });

  it.each(['rule', 'expose'] as const)('resolves the %s finale branch and skips the other', (choice) => {
    const started = startMission(stateBeforeFinale(), 'freehold', MISSIONS);
    if (!started.success) throw new Error(started.reason);
    expect(isObjectiveAvailable(started.state, FREEHOLD, 'freehold:rule')).toBe(false);

    const chose = completeObjective(started.state, 'freehold:choice', MISSIONS, choice);
    if (!chose.success) throw new Error(chose.reason);
    expect(isObjectiveAvailable(chose.state, FREEHOLD, `freehold:${choice}`)).toBe(true);
    expect(isObjectiveAvailable(
      chose.state,
      FREEHOLD,
      choice === 'rule' ? 'freehold:expose' : 'freehold:rule',
    )).toBe(false);

    const branch = completeObjective(chose.state, `freehold:${choice}`, MISSIONS);
    if (!branch.success) throw new Error(branch.reason);
    expect(isObjectiveAvailable(branch.state, FREEHOLD, 'freehold:escape')).toBe(true);
    const escaped = completeObjective(branch.state, 'freehold:escape', MISSIONS);
    if (!escaped.success) throw new Error(escaped.reason);
    const completed = completeMission(escaped.state, MISSIONS);

    expect(completed.success).toBe(true);
    if (completed.success) {
      expect(completed.ending).toBe(choice);
      expect(completed.state.ending).toBe(choice);
      expect(completed.branchReward?.choice).toBe(choice);
      expect(completed.state.worldFlags).toContain(`ending-${choice}`);
      expect(completed.state.activeMissionId).toBeNull();
    }
  });

  it('abandons active work back to a repeatable available state', () => {
    const started = startMission(createCampaignState(MISSIONS), 'past-due', MISSIONS);
    if (!started.success) throw new Error(started.reason);
    const abandoned = abandonMission(started.state, MISSIONS);

    expect(abandoned.success).toBe(true);
    if (abandoned.success) {
      expect(abandoned.state.activeMissionId).toBeNull();
      expect(abandoned.state.missions['past-due']?.state).toBe('available');
    }
  });
});
