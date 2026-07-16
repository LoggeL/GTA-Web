import { describe, expect, it } from 'vitest';

import { MISSIONS } from '../../src/data/missions';
import { DialogueRuntime } from '../../src/runtime/DialogueRuntime';
import {
  completeObjective,
  createCampaignState,
  startMission,
  type CampaignState,
} from '../../src/systems/campaign';
import {
  buildContactReputationProgress,
  buildMissionLog,
  findMissionLogEntry,
} from '../../src/systems/missionLog';

describe('mission log read model', () => {
  it('summarizes all authored missions, gates, objectives, and rewards without mutation', () => {
    const campaign = createCampaignState(MISSIONS);
    const before = JSON.stringify(campaign);
    const log = buildMissionLog(campaign);
    const prologue = findMissionLogEntry(log, 'past-due');
    const rollingStock = findMissionLogEntry(log, 'rolling-stock');

    expect(log.missions).toHaveLength(12);
    expect(log.missionCounts).toEqual({ locked: 11, available: 1, active: 0, complete: 0 });
    expect(prologue?.status).toBe('available');
    expect(prologue?.gate.canStart).toBe(true);
    expect(prologue?.objectives[0]).toEqual(expect.objectContaining({
      status: 'pending',
      completionText: 'Hold for 75 seconds',
    }));
    expect(prologue?.reward).toEqual(expect.objectContaining({ cash: 850, xp: 650 }));
    expect(rollingStock?.gate.blockers).toEqual([
      'level',
      'prerequisite',
      'reputation',
    ]);
    expect(rollingStock?.gate.reputation).toEqual(expect.objectContaining({
      contact: 'juno',
      current: 0,
      required: 2,
      remaining: 2,
      met: false,
    }));
    expect(JSON.stringify(campaign)).toBe(before);
  });

  it('projects completed, active, pending, and branch-skipped objective states', () => {
    let campaign = createCampaignState(MISSIONS);
    const started = startMission(campaign, 'past-due', MISSIONS);
    if (!started.success) throw new Error(started.reason);
    campaign = started.state;
    const completed = completeObjective(campaign, 'past-due:defend-garage', MISSIONS);
    if (!completed.success) throw new Error(completed.reason);
    campaign = completed.state;
    const prologue = findMissionLogEntry(buildMissionLog(campaign), 'past-due');

    expect(prologue?.status).toBe('active');
    expect(prologue?.checkpointId).toBe('past-due:start');
    expect(prologue?.objectives.map((objective) => objective.status)).toEqual([
      'complete',
      'active',
      'pending',
      'pending',
    ]);
    expect(prologue?.gate.canStart).toBe(false);

    const finaleCampaign = withFinaleChoice(createCampaignState(MISSIONS, 20), 'rule');
    const finale = findMissionLogEntry(buildMissionLog(finaleCampaign), 'freehold');
    expect(finale?.objectives.find((objective) => objective.id === 'freehold:rule-network')?.status)
      .toBe('active');
    expect(finale?.objectives.find((objective) => objective.id === 'freehold:expose-network')?.status)
      .toBe('skipped');
  });

  it('includes only reviewed story text, including dialogue made reviewable by skipping', () => {
    const dialogue = new DialogueRuntime();
    dialogue.startMission('past-due');
    dialogue.skip();
    dialogue.startMission('coastline-burn');
    const log = buildMissionLog(createCampaignState(MISSIONS), {
      reviewedDialogueKeys: dialogue.reviewedKeys,
    });

    expect(findMissionLogEntry(log, 'past-due')?.reviewedStory).toHaveLength(4);
    expect(findMissionLogEntry(log, 'past-due')?.reviewedStory[3]?.channel).toBe('mission-log');
    expect(findMissionLogEntry(log, 'coastline-burn')?.reviewedStory.map((entry) => entry.key))
      .toEqual(['coastline-burn.briefing']);
    expect(findMissionLogEntry(log, 'rolling-stock')?.reviewedStory).toEqual([]);
  });

  it('tracks contact chain progress and exact reputation gates', () => {
    const campaign = createCampaignState(MISSIONS);
    campaign.contacts.juno = 2;
    campaign.missions['coastline-burn']!.state = 'complete';
    const contacts = buildContactReputationProgress(campaign);
    const juno = contacts.find((contact) => contact.id === 'juno');

    expect(juno).toEqual(expect.objectContaining({
      current: 2,
      highestAuthoredGate: 5,
      gateProgress: 0.4,
      completedChainMissions: 1,
      nextChainMissionId: 'rolling-stock',
    }));
    expect(juno?.gates.map((gate) => [gate.missionId, gate.required, gate.remaining, gate.met]))
      .toEqual([
        ['rolling-stock', 2, 0, true],
        ['bridge-run', 5, 3, false],
      ]);
    expect(juno?.nextGate?.missionId).toBe('bridge-run');
  });

  it.each(['rule', 'expose'] as const)('reveals only the selected %s ending recap', (choice) => {
    const campaign = withFinaleChoice(createCampaignState(MISSIONS, 20), choice, true);
    const finale = findMissionLogEntry(buildMissionLog(campaign), 'freehold');
    const selected = finale?.ending?.options.find((option) => option.selected);
    const unselected = finale?.ending?.options.find((option) => !option.selected);

    expect(finale?.ending?.selectedChoice).toBe(choice);
    expect(selected?.choice).toBe(choice);
    expect(selected?.recap).toContain(choice === 'rule' ? 'seizes' : 'broadcasts');
    expect(unselected?.recap).toBeNull();
  });
});

function withFinaleChoice(
  campaign: CampaignState,
  choice: 'rule' | 'expose',
  completed = false,
): CampaignState {
  campaign.activeMissionId = completed ? null : 'freehold';
  campaign.ending = completed ? choice : null;
  campaign.missions.freehold = {
    state: completed ? 'complete' : 'active',
    checkpointId: 'freehold:rooftop',
    completedObjectives: [
      'freehold:infiltrate-tower',
      'freehold:reach-uplink',
      'freehold:choose-future',
    ],
    choices: { 'freehold:choose-future': choice },
  };
  return campaign;
}
