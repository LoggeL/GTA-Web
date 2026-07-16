import { describe, expect, it, vi } from 'vitest';

import { CHECKPOINTS, MISSIONS } from '../../src/data/missions';
import type { MissionDefinition, MissionId, ObjectiveDefinition } from '../../src/data/types';
import { MissionRuntime, type ObjectiveUpdate } from '../../src/runtime/MissionRuntime';

const CONTACT_MISSIONS = new Set<MissionId>([
  'coastline-burn',
  'rolling-stock',
  'bridge-run',
  'last-call',
  'glass-house',
  'container-zero',
  'dead-air',
  'night-train',
  'black-grid',
]);

const LEGAL_ORDERS: readonly (readonly MissionId[])[] = [
  [
    'coastline-burn', 'rolling-stock', 'bridge-run',
    'last-call', 'glass-house', 'container-zero',
    'dead-air', 'night-train', 'black-grid',
  ],
  [
    'dead-air', 'last-call', 'coastline-burn',
    'night-train', 'rolling-stock', 'glass-house',
    'container-zero', 'black-grid', 'bridge-run',
  ],
];

function objectiveUpdate(
  objective: Readonly<ObjectiveDefinition>,
  ending: 'rule' | 'expose',
): readonly ObjectiveUpdate[] {
  switch (objective.completion.kind) {
    case 'all-targets':
      return objective.targetIds.map((targetId) => ({ kind: 'target', targetId }));
    case 'target-count':
      return [{ kind: 'increment', amount: objective.completion.required }];
    case 'reach-destination':
      return [{ kind: 'position', distanceMeters: 0 }];
    case 'survive':
      return [{ kind: 'elapsed', seconds: objective.completion.durationSeconds }];
    case 'lose-wanted':
      return [{ kind: 'wanted', level: objective.completion.maximumLevel }];
    case 'choice-made':
      return [{ kind: 'choice', choice: ending }];
    case 'composite':
      return [{ kind: 'complete' }];
  }
}

function verifyCheckpointRecovery(runtime: MissionRuntime, reached: Set<string>): void {
  const before = runtime.activeMission;
  const checkpointId = before?.checkpoint.checkpointId;
  if (!before || checkpointId == null || reached.has(checkpointId)) {
    return;
  }
  reached.add(checkpointId);
  expect(runtime.failMission('player-defeat', `checkpoint audit: ${checkpointId}`).success).toBe(true);
  expect(runtime.retryMission().success).toBe(true);
  expect(runtime.activeMission).toEqual(before);
}

function finishActiveMission(
  runtime: MissionRuntime,
  definition: Readonly<MissionDefinition>,
  ending: 'rule' | 'expose',
  reachedCheckpoints: Set<string>,
): void {
  verifyCheckpointRecovery(runtime, reachedCheckpoints);
  let guard = 0;
  while (runtime.activeObjectiveIds().length > 0) {
    guard += 1;
    if (guard > definition.objectives.length * 2) {
      throw new Error(`Objective graph did not converge for ${definition.id}`);
    }
    const activeIds = [...runtime.activeObjectiveIds()];
    for (const objectiveId of activeIds) {
      const objective = definition.objectives.find((entry) => entry.id === objectiveId);
      if (!objective) {
        throw new Error(`Missing authored objective ${objectiveId}`);
      }
      for (const update of objectiveUpdate(objective, ending)) {
        const result = runtime.updateObjective(objectiveId, update);
        expect(result, `${definition.id}/${objectiveId}/${update.kind}`).toEqual({ success: true });
      }
      verifyCheckpointRecovery(runtime, reachedCheckpoints);
    }
  }
  expect(runtime.succeedMission(), definition.id).toEqual({ success: true });
}

function playCampaign(
  order: readonly MissionId[],
  ending: 'rule' | 'expose',
): { runtime: MissionRuntime; checkpoints: Set<string> } {
  const runtime = new MissionRuntime();
  const checkpoints = new Set<string>();
  const rewardEvents = vi.fn();
  runtime.events.on('reward:granted', rewardEvents);

  expect(runtime.availableMissionIds()).toEqual(['past-due']);
  expect(runtime.startMission('past-due')).toEqual({ success: true });
  finishActiveMission(runtime, MISSIONS[0]!, ending, checkpoints);
  runtime.setPlayerLevel(20);

  expect(new Set(runtime.availableMissionIds())).toEqual(new Set([
    'coastline-burn', 'last-call', 'dead-air',
  ]));
  for (const missionId of order) {
    expect(CONTACT_MISSIONS.has(missionId)).toBe(true);
    expect(runtime.availableMissionIds(), `${missionId} must be legal in this order`).toContain(missionId);
    expect(runtime.startMission(missionId)).toEqual({ success: true });
    const definition = MISSIONS.find((mission) => mission.id === missionId);
    if (!definition) throw new Error(`Missing authored mission ${missionId}`);
    finishActiveMission(runtime, definition, ending, checkpoints);
  }

  expect(runtime.availableMissionIds()).toContain('full-account');
  expect(runtime.startMission('full-account')).toEqual({ success: true });
  finishActiveMission(runtime, MISSIONS.find((mission) => mission.id === 'full-account')!, ending, checkpoints);
  expect(runtime.availableMissionIds()).toContain('freehold');
  expect(runtime.startMission('freehold')).toEqual({ success: true });
  finishActiveMission(runtime, MISSIONS.find((mission) => mission.id === 'freehold')!, ending, checkpoints);

  expect(rewardEvents).toHaveBeenCalledTimes(12);
  return { runtime, checkpoints };
}

describe('authored twelve-mission campaign acceptance', () => {
  it.each([
    { label: 'contact-chain order / Rule', order: LEGAL_ORDERS[0]!, ending: 'rule' as const },
    { label: 'interleaved order / Expose', order: LEGAL_ORDERS[1]!, ending: 'expose' as const },
  ])('finishes $label, restores every checkpoint, and continues in free roam', ({ order, ending }) => {
    const { runtime, checkpoints } = playCampaign(order, ending);
    const campaign = runtime.campaignState;
    const summary = runtime.completionSummary();

    expect([...checkpoints].sort()).toEqual(CHECKPOINTS.map((checkpoint) => checkpoint.id).sort());
    expect(Object.values(campaign.missions).every((progress) => progress.state === 'complete')).toBe(true);
    expect(campaign.activeMissionId).toBeNull();
    expect(campaign.ending).toBe(ending);
    expect(campaign.contacts).toEqual({ juno: 15, malik: 15, priya: 15 });
    expect(campaign.worldFlags).toEqual(expect.arrayContaining([
      'postgame-free-roam',
      'ending-choice-applied',
      `ending-${ending}`,
    ]));
    expect(runtime.availableMissionIds()).toEqual([]);
    expect(runtime.activeMission).toBeNull();
    expect(runtime.missionLog().every((entry) => (
      entry.state === 'complete' && entry.activeObjectiveIds.length === 0
    ))).toBe(true);
    expect(summary).toMatchObject({
      completedMissionCount: 12,
      totalMissionCount: 12,
      completedContactJobCount: 9,
      totalContactJobCount: 9,
      ending,
      storyComplete: true,
      postgameFreeRoam: true,
    });

    const restored = new MissionRuntime();
    expect(restored.restore(JSON.parse(JSON.stringify(runtime.snapshot())) as unknown)).toEqual({ success: true });
    expect(restored.completionSummary()).toEqual(summary);
    restored.addContactReputation('juno', 1);
    expect(restored.campaignState.contacts.juno).toBe(16);
    expect(restored.completionSummary().postgameFreeRoam).toBe(true);
  });

  it('keeps finale modifiers and branch objectives mutually exclusive', () => {
    const rule = playCampaign(LEGAL_ORDERS[0]!, 'rule').runtime;
    const expose = playCampaign(LEGAL_ORDERS[1]!, 'expose').runtime;
    const finale = MISSIONS.find((mission) => mission.id === 'freehold')!;
    const ruleReward = finale.branchRewards?.find((reward) => reward.choice === 'rule');
    const exposeReward = finale.branchRewards?.find((reward) => reward.choice === 'expose');

    expect(ruleReward?.modifiers).toEqual(expect.arrayContaining([
      { stat: 'propertyIncome', percent: 20 },
      { stat: 'blackMarketPrice', percent: -10 },
      { stat: 'heatGain', percent: 10 },
    ]));
    expect(exposeReward?.modifiers).toEqual(expect.arrayContaining([
      { stat: 'wantedSearchDuration', percent: -20 },
      { stat: 'legitimatePropertyPerk', percent: 20 },
      { stat: 'blackMarketPrice', percent: 10 },
    ]));
    expect(rule.campaignState.worldFlags).toContain('ending-rule');
    expect(rule.campaignState.worldFlags).not.toContain('ending-expose');
    expect(expose.campaignState.worldFlags).toContain('ending-expose');
    expect(expose.campaignState.worldFlags).not.toContain('ending-rule');
  });
});
