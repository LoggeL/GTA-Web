import { describe, expect, it, vi } from 'vitest';

import { createGameEventBus } from '../../src/core/events';
import type { MissionDefinition, ObjectiveDefinition } from '../../src/data/types';
import { MissionRuntime } from '../../src/runtime/MissionRuntime';

function finishPastDue(runtime: MissionRuntime): void {
  expect(runtime.startMission('past-due').success).toBe(true);
  expect(runtime.tick(75).success).toBe(true);
  for (const targetId of [
    'garage-medkit',
    'garage-vehicle-repair-kit',
    'garage-practice-pistol',
  ]) {
    expect(runtime.updateObjective('past-due:grab-essentials', { kind: 'target', targetId }).success).toBe(true);
  }
  expect(runtime.updateObjective('past-due:chase-tow-truck', {
    kind: 'increment', amount: 4,
  }).success).toBe(true);
  for (const targetId of ['tow-release', 'moreno-garage-delivery']) {
    expect(runtime.updateObjective('past-due:recover-customer-car', { kind: 'target', targetId }).success).toBe(true);
  }
}

function missionWithObjectives(objectives: readonly ObjectiveDefinition[]): MissionDefinition {
  return {
    id: 'past-due',
    number: 1,
    title: 'Runtime Test',
    subtitle: '',
    contact: 'garage',
    district: 'arroyo-heights',
    prerequisites: [],
    levelGate: 1,
    startTrigger: { kind: 'automatic', targetId: 'start' },
    objectives,
    checkpoints: [{
      id: 'test:start', label: 'Start', afterObjectiveId: null,
      respawn: { district: 'arroyo-heights', x: 0, y: 0, z: 0 },
      restore: { healthPercent: 100, armorPercent: 0, refillMissionItems: true },
    }],
    rewards: {
      id: 'test:reward', cash: 100, xp: 50, reputation: { juno: 2 },
      items: [{ itemId: 'medkit', quantity: 1 }], unlockFlags: ['test-complete'],
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

const RESTART = { mode: 'restart-checkpoint', description: '' } as const;

describe('MissionRuntime with authored registry', () => {
  it('runs objective types, checkpoints, rewards, events, and prerequisite gates', () => {
    const gameEvents = createGameEventBus();
    const lifecycle = vi.fn();
    const reward = vi.fn();
    gameEvents.on('mission:lifecycle', lifecycle);
    const runtime = new MissionRuntime({ gameEvents });
    runtime.events.on('reward:granted', reward);

    expect(runtime.availableMissionIds()).toContain('past-due');
    expect(runtime.startMission('coastline-burn').success).toBe(false);
    finishPastDue(runtime);
    expect(runtime.activeObjectiveIds()).toEqual([]);
    expect(runtime.succeedMission().success).toBe(true);

    expect(reward).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'past-due',
      rewards: expect.objectContaining({ cash: 850, xp: 650 }),
    }));
    expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'past-due', state: 'completed',
    }));
    expect(runtime.campaignState.worldFlags).toContain('open-world');
    expect(runtime.availableMissionIds()).not.toContain('coastline-burn');
    runtime.setPlayerLevel(2);
    expect(runtime.availableMissionIds()).toContain('coastline-burn');
  });

  it('restores the latest checkpoint on failure and retry', () => {
    const runtime = new MissionRuntime();
    expect(runtime.startMission('past-due').success).toBe(true);
    expect(runtime.tick(75).success).toBe(true);
    for (const targetId of [
      'garage-medkit', 'garage-vehicle-repair-kit', 'garage-practice-pistol',
    ]) {
      runtime.updateObjective('past-due:grab-essentials', { kind: 'target', targetId });
    }
    expect(runtime.activeMission?.checkpoint.checkpointId).toBe('past-due:chase');
    runtime.updateObjective('past-due:chase-tow-truck', { kind: 'increment', amount: 2 });

    expect(runtime.failMission('player-defeat', 'Alex was defeated').success).toBe(true);
    expect(runtime.activeMission?.status).toBe('failed');
    expect(runtime.retryMission().success).toBe(true);
    expect(runtime.activeMission?.objectiveProgress['past-due:chase-tow-truck']?.current).toBe(0);
    expect(runtime.activeMission?.objectiveProgress['past-due:grab-essentials']?.completed).toBe(true);
  });

  it('fails timed objectives and can retry from the same checkpoint', () => {
    const runtime = new MissionRuntime();
    runtime.startMission('past-due');
    runtime.tick(75);
    for (const targetId of [
      'garage-medkit', 'garage-vehicle-repair-kit', 'garage-practice-pistol',
    ]) {
      runtime.updateObjective('past-due:grab-essentials', { kind: 'target', targetId });
    }

    expect(runtime.tick(210).success).toBe(true);
    expect(runtime.activeMission?.status).toBe('failed');
    expect(runtime.activeMission?.failure?.kind).toBe('objective-timeout');
    expect(runtime.retryMission().success).toBe(true);
  });

  it('round-trips a serializable snapshot and rejects incompatible state safely', () => {
    const first = new MissionRuntime();
    first.startMission('past-due');
    first.tick(20);
    const serialized = JSON.parse(JSON.stringify(first.snapshot())) as unknown;
    const second = new MissionRuntime();

    expect(second.restore(serialized).success).toBe(true);
    expect(second.snapshot()).toEqual(first.snapshot());
    const before = second.snapshot();
    expect(second.restore({ snapshotVersion: 99 }).success).toBe(false);
    expect(second.snapshot()).toEqual(before);
  });

  it('rejects malformed active objective progress without mutating runtime state', () => {
    const source = new MissionRuntime();
    source.startMission('past-due');
    const snapshot = source.snapshot();
    const active = snapshot.active;
    if (!active) {
      throw new Error('Expected an active mission snapshot');
    }
    const malformed: unknown = {
      ...snapshot,
      active: {
        ...active,
        objectiveProgress: {
          ...active.objectiveProgress,
          'past-due:defend-garage': {
            ...active.objectiveProgress['past-due:defend-garage'],
            current: 'not-a-number',
          },
        },
      },
    };
    const target = new MissionRuntime();
    const before = target.snapshot();

    expect(target.restore(malformed).success).toBe(false);
    expect(target.snapshot()).toEqual(before);
  });
});

describe('MissionRuntime objective and fallback routing', () => {
  it('handles position, wanted, choice, and automatic composite completion', () => {
    const mission = missionWithObjectives([
      {
        id: 'reach', type: 'reach', title: '', description: '', targetIds: ['destination'],
        completion: { kind: 'reach-destination', radiusMeters: 3 }, optional: false,
        fallback: RESTART, nextObjectiveIds: ['evade'],
      },
      {
        id: 'evade', type: 'evade', title: '', description: '', targetIds: ['search'],
        completion: { kind: 'lose-wanted', maximumLevel: 0 }, optional: false,
        fallback: RESTART, nextObjectiveIds: ['choice'],
      },
      {
        id: 'choice', type: 'choice', title: '', description: '', targetIds: [],
        completion: { kind: 'choice-made', choices: ['rule', 'expose'] }, optional: false,
        fallback: RESTART, nextObjectiveIds: ['branch'],
      },
      {
        id: 'branch', type: 'interact', title: '', description: '', targetIds: ['terminal'],
        completion: { kind: 'all-targets' }, optional: false, fallback: RESTART,
        nextObjectiveIds: ['composite'], activation: { choiceObjectiveId: 'choice', choice: 'rule' },
      },
      {
        id: 'composite', type: 'composite', title: '', description: '', targetIds: [],
        completion: { kind: 'composite', requiredObjectiveIds: ['reach', 'branch'] },
        optional: false, fallback: RESTART, nextObjectiveIds: [],
      },
    ]);
    const runtime = new MissionRuntime({ missions: [mission] });
    runtime.startMission('past-due');

    expect(runtime.updateObjective('reach', { kind: 'position', distanceMeters: 10 }).success).toBe(true);
    expect(runtime.activeObjectiveIds()).toEqual(['reach']);
    runtime.updateObjective('reach', { kind: 'position', distanceMeters: 2 });
    runtime.updateObjective('evade', { kind: 'wanted', level: 0 });
    expect(runtime.updateObjective('choice', { kind: 'choice', choice: 'invalid' }).success).toBe(false);
    runtime.updateObjective('choice', { kind: 'choice', choice: 'rule' });
    runtime.updateObjective('branch', { kind: 'target', targetId: 'terminal' });

    expect(runtime.activeMission?.objectiveProgress.composite?.completed).toBe(true);
    expect(runtime.succeedMission().success).toBe(true);
  });

  it('keeps continue fallbacks active and skips a graph path for alternate fallbacks', () => {
    const mission = missionWithObjectives([
      {
        id: 'entry', type: 'stealth-hack', title: '', description: '', targetIds: ['door'],
        completion: { kind: 'all-targets' }, optional: false,
        fallback: { mode: 'continue', description: '' }, nextObjectiveIds: ['stealth'],
      },
      {
        id: 'stealth', type: 'stealth-hack', title: '', description: '', targetIds: ['office'],
        completion: { kind: 'all-targets' }, optional: false,
        fallback: { mode: 'alternate-objective', objectiveId: 'escape', description: '' },
        nextObjectiveIds: ['plant'],
      },
      {
        id: 'plant', type: 'interact', title: '', description: '', targetIds: ['device'],
        completion: { kind: 'all-targets' }, optional: false, fallback: RESTART,
        nextObjectiveIds: ['escape'],
      },
      {
        id: 'escape', type: 'reach', title: '', description: '', targetIds: ['exit'],
        completion: { kind: 'all-targets' }, optional: false, fallback: RESTART,
        nextObjectiveIds: [],
      },
    ]);
    const runtime = new MissionRuntime({ missions: [mission] });
    runtime.startMission('past-due');

    expect(runtime.failObjective('entry', 'Detected').success).toBe(true);
    expect(runtime.activeObjectiveIds()).toEqual(['entry']);
    runtime.updateObjective('entry', { kind: 'target', targetId: 'door' });
    expect(runtime.failObjective('stealth', 'Cover blown').success).toBe(true);
    expect(runtime.activeObjectiveIds()).toEqual(['escape']);
    expect(runtime.activeMission?.objectiveProgress.plant?.skipped).toBe(true);
    runtime.updateObjective('escape', { kind: 'target', targetId: 'exit' });
    expect(runtime.succeedMission().success).toBe(true);
  });

  it('abandons active missions back to available state', () => {
    const runtime = new MissionRuntime();
    runtime.startMission('past-due');
    expect(runtime.abandonMission().success).toBe(true);
    expect(runtime.activeMission).toBeNull();
    expect(runtime.availableMissionIds()).toContain('past-due');
  });
});
