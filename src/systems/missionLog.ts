import { ENDING_RECAPS, STORY_CONTACTS } from '../data/dialogue';
import { DIALOGUE, MISSIONS } from '../data/missions';
import type {
  CompletionCondition,
  DialogueEntry,
  DistrictId,
  ItemGrant,
  MissionDefinition,
  MissionId,
  ObjectiveType,
} from '../data/types';
import {
  isObjectiveAvailable,
  type CampaignContactId,
  type CampaignMissionProgress,
  type CampaignMissionStatus,
  type CampaignState,
} from './campaign';

export type MissionLogObjectiveStatus = 'active' | 'complete' | 'pending' | 'skipped';
export type MissionGateBlocker = 'level' | 'prerequisite' | 'reputation' | 'another-mission-active';

export interface MissionLogObjectiveSummary {
  readonly id: string;
  readonly type: ObjectiveType;
  readonly title: string;
  readonly description: string;
  readonly completionText: string;
  readonly optional: boolean;
  readonly status: MissionLogObjectiveStatus;
}

export interface MissionPrerequisiteGateSummary {
  readonly missionId: MissionId;
  readonly title: string;
  readonly complete: boolean;
}

export interface MissionReputationGateSummary {
  readonly contact: CampaignContactId;
  readonly current: number;
  readonly required: number;
  readonly remaining: number;
  readonly met: boolean;
}

export interface MissionGateSummary {
  readonly met: boolean;
  readonly canStart: boolean;
  readonly blockers: readonly MissionGateBlocker[];
  readonly level: { readonly current: number; readonly required: number; readonly met: boolean };
  readonly prerequisites: readonly MissionPrerequisiteGateSummary[];
  readonly reputation: MissionReputationGateSummary | null;
}

export interface MissionRewardSummary {
  readonly cash: number;
  readonly xp: number;
  readonly reputation: readonly { readonly contact: CampaignContactId; readonly amount: number }[];
  readonly items: readonly ItemGrant[];
  readonly unlockFlags: readonly string[];
}

export interface MissionEndingOptionSummary {
  readonly choice: 'rule' | 'expose';
  readonly title: string;
  readonly selected: boolean;
  readonly recap: string | null;
  readonly unlockFlag: string;
  readonly modifiers: readonly { readonly stat: string; readonly percent: number }[];
}

export interface MissionEndingSummary {
  readonly selectedChoice: 'rule' | 'expose' | null;
  readonly options: readonly MissionEndingOptionSummary[];
}

export interface MissionLogEntry {
  readonly id: MissionId;
  readonly number: number;
  readonly title: string;
  readonly subtitle: string;
  readonly contact: MissionDefinition['contact'];
  readonly district: DistrictId;
  readonly status: CampaignMissionStatus;
  readonly checkpointId: string | null;
  readonly gate: MissionGateSummary;
  readonly objectives: readonly MissionLogObjectiveSummary[];
  readonly completedObjectiveCount: number;
  readonly requiredObjectiveCount: number;
  readonly reward: MissionRewardSummary;
  readonly reviewedStory: readonly DialogueEntry[];
  readonly ending: MissionEndingSummary | null;
}

export interface ContactMissionGateProgress {
  readonly missionId: MissionId;
  readonly title: string;
  readonly required: number;
  readonly current: number;
  readonly remaining: number;
  readonly met: boolean;
  readonly missionStatus: CampaignMissionStatus;
}

export interface ContactReputationProgress {
  readonly id: CampaignContactId;
  readonly name: string;
  readonly role: string;
  readonly current: number;
  readonly highestAuthoredGate: number;
  readonly gateProgress: number;
  readonly gates: readonly ContactMissionGateProgress[];
  readonly nextGate: ContactMissionGateProgress | null;
  readonly chainMissionIds: readonly MissionId[];
  readonly completedChainMissions: number;
  readonly nextChainMissionId: MissionId | null;
}

export interface MissionLogSnapshot {
  readonly activeMissionId: MissionId | null;
  readonly ending: 'rule' | 'expose' | null;
  readonly missionCounts: Readonly<Record<CampaignMissionStatus, number>>;
  readonly missions: readonly MissionLogEntry[];
  readonly contacts: readonly ContactReputationProgress[];
}

export interface BuildMissionLogOptions {
  readonly definitions?: readonly MissionDefinition[];
  readonly dialogue?: readonly DialogueEntry[];
  readonly reviewedDialogueKeys?: readonly string[];
}

/** Pure read model for mission journal, objective tracker, rewards, endings, and contact gates. */
export function buildMissionLog(
  campaign: Readonly<CampaignState>,
  options: Readonly<BuildMissionLogOptions> = {},
): MissionLogSnapshot {
  const definitions = options.definitions ?? MISSIONS;
  const dialogue = options.dialogue ?? DIALOGUE;
  const reviewed = new Set(options.reviewedDialogueKeys ?? []);
  const missions = [...definitions]
    .sort((left, right) => left.number - right.number)
    .map((definition) => buildMissionEntry(campaign, definition, definitions, dialogue, reviewed));
  const missionCounts: Record<CampaignMissionStatus, number> = {
    locked: 0,
    available: 0,
    active: 0,
    complete: 0,
  };
  for (const mission of missions) {
    missionCounts[mission.status] += 1;
  }

  return {
    activeMissionId: campaign.activeMissionId,
    ending: campaign.ending,
    missionCounts,
    missions,
    contacts: buildContactReputationProgress(campaign, definitions),
  };
}

export function buildContactReputationProgress(
  campaign: Readonly<CampaignState>,
  definitions: readonly MissionDefinition[] = MISSIONS,
): readonly ContactReputationProgress[] {
  return STORY_CONTACTS.map((profile) => {
    const current = campaign.contacts[profile.id];
    const gates = definitions
      .filter((mission) => mission.reputationGate?.contact === profile.id)
      .sort((left, right) => {
        const minimumDifference = left.reputationGate!.minimum - right.reputationGate!.minimum;
        return minimumDifference === 0 ? left.number - right.number : minimumDifference;
      })
      .map((mission): ContactMissionGateProgress => {
        const required = mission.reputationGate!.minimum;
        return {
          missionId: mission.id,
          title: mission.title,
          required,
          current,
          remaining: Math.max(0, required - current),
          met: current >= required,
          missionStatus: campaign.missions[mission.id]?.state ?? 'locked',
        };
      });
    const chain = definitions
      .filter((mission) => mission.contact === profile.id)
      .sort((left, right) => left.number - right.number);
    const highestAuthoredGate = gates.reduce((maximum, gate) => Math.max(maximum, gate.required), 0);
    const nextGate = gates.find((gate) => !gate.met) ?? null;
    const nextChainMission = chain.find(
      (mission) => campaign.missions[mission.id]?.state !== 'complete',
    );
    return {
      id: profile.id,
      name: profile.name,
      role: profile.role,
      current,
      highestAuthoredGate,
      gateProgress: highestAuthoredGate === 0 ? 1 : Math.min(1, current / highestAuthoredGate),
      gates,
      nextGate,
      chainMissionIds: chain.map((mission) => mission.id),
      completedChainMissions: chain.filter(
        (mission) => campaign.missions[mission.id]?.state === 'complete',
      ).length,
      nextChainMissionId: nextChainMission?.id ?? null,
    };
  });
}

export function findMissionLogEntry(
  log: Readonly<MissionLogSnapshot>,
  missionId: MissionId,
): MissionLogEntry | null {
  return log.missions.find((mission) => mission.id === missionId) ?? null;
}

function buildMissionEntry(
  campaign: Readonly<CampaignState>,
  definition: MissionDefinition,
  definitions: readonly MissionDefinition[],
  dialogue: readonly DialogueEntry[],
  reviewed: ReadonlySet<string>,
): MissionLogEntry {
  const progress = campaign.missions[definition.id] ?? createLockedProgress();
  const objectives = definition.objectives.map((objective): MissionLogObjectiveSummary => ({
    id: objective.id,
    type: objective.type,
    title: objective.title,
    description: objective.description,
    completionText: completionText(objective.completion, objective.targetIds.length),
    optional: objective.optional,
    status: objectiveStatus(campaign, definition, progress, objective.id),
  }));
  const reviewedStory = definition.dialogueKeys
    .filter((key) => reviewed.has(key))
    .map((key) => dialogue.find((entry) => entry.key === key))
    .filter((entry): entry is DialogueEntry => entry !== undefined && entry.missionId === definition.id);
  return {
    id: definition.id,
    number: definition.number,
    title: definition.title,
    subtitle: definition.subtitle,
    contact: definition.contact,
    district: definition.district,
    status: progress.state,
    checkpointId: progress.checkpointId,
    gate: gateSummary(campaign, definition, definitions, progress.state),
    objectives,
    completedObjectiveCount: objectives.filter((objective) => objective.status === 'complete').length,
    requiredObjectiveCount: objectives.filter(
      (objective) => !objective.optional && objective.status !== 'skipped',
    ).length,
    reward: rewardSummary(definition),
    reviewedStory,
    ending: endingSummary(campaign, definition, progress),
  };
}

function objectiveStatus(
  campaign: Readonly<CampaignState>,
  definition: MissionDefinition,
  progress: Readonly<CampaignMissionProgress>,
  objectiveId: string,
): MissionLogObjectiveStatus {
  if (progress.completedObjectives.includes(objectiveId)) {
    return 'complete';
  }
  const objective = definition.objectives.find((entry) => entry.id === objectiveId);
  if (!objective) {
    return 'pending';
  }
  if (objective.activation) {
    const choice = progress.choices[objective.activation.choiceObjectiveId];
    if (choice !== undefined && choice !== objective.activation.choice) {
      return 'skipped';
    }
  }
  if (progress.state === 'active' && isObjectiveAvailable(campaign, definition, objectiveId)) {
    return 'active';
  }
  if (progress.state === 'complete') {
    return 'skipped';
  }
  return 'pending';
}

function gateSummary(
  campaign: Readonly<CampaignState>,
  definition: MissionDefinition,
  definitions: readonly MissionDefinition[],
  status: CampaignMissionStatus,
): MissionGateSummary {
  const level = {
    current: campaign.level,
    required: definition.levelGate,
    met: campaign.level >= definition.levelGate,
  };
  const prerequisites = definition.prerequisites.map((missionId) => ({
    missionId,
    title: definitions.find((entry) => entry.id === missionId)?.title ?? missionId,
    complete: campaign.missions[missionId]?.state === 'complete',
  }));
  const reputation = definition.reputationGate
    ? {
      contact: definition.reputationGate.contact,
      current: campaign.contacts[definition.reputationGate.contact],
      required: definition.reputationGate.minimum,
      remaining: Math.max(
        0,
        definition.reputationGate.minimum - campaign.contacts[definition.reputationGate.contact],
      ),
      met: campaign.contacts[definition.reputationGate.contact] >= definition.reputationGate.minimum,
    }
    : null;
  const blockers: MissionGateBlocker[] = [];
  if (!level.met) blockers.push('level');
  if (prerequisites.some((gate) => !gate.complete)) blockers.push('prerequisite');
  if (reputation && !reputation.met) blockers.push('reputation');
  if (campaign.activeMissionId !== null && status === 'available') {
    blockers.push('another-mission-active');
  }
  const met = level.met
    && prerequisites.every((gate) => gate.complete)
    && (reputation?.met ?? true);
  return {
    met,
    canStart: status === 'available' && campaign.activeMissionId === null && met,
    blockers,
    level,
    prerequisites,
    reputation,
  };
}

function rewardSummary(definition: MissionDefinition): MissionRewardSummary {
  const reputation: { contact: CampaignContactId; amount: number }[] = [];
  for (const contact of ['juno', 'malik', 'priya'] as const) {
    const amount = definition.rewards.reputation[contact];
    if (amount !== undefined) {
      reputation.push({ contact, amount });
    }
  }
  return {
    cash: definition.rewards.cash,
    xp: definition.rewards.xp,
    reputation,
    items: definition.rewards.items.map((item) => ({ ...item })),
    unlockFlags: [...definition.rewards.unlockFlags],
  };
}

function endingSummary(
  campaign: Readonly<CampaignState>,
  definition: MissionDefinition,
  progress: Readonly<CampaignMissionProgress>,
): MissionEndingSummary | null {
  if (!definition.branchRewards) {
    return null;
  }
  const selectedChoice = campaign.ending
    ?? Object.values(progress.choices).find(isEndingChoice)
    ?? null;
  return {
    selectedChoice,
    options: definition.branchRewards.map((reward) => {
      const selected = reward.choice === selectedChoice;
      const recap = ENDING_RECAPS.find((entry) => entry.choice === reward.choice);
      return {
        choice: reward.choice,
        title: recap?.title ?? reward.choice,
        selected,
        recap: selected ? recap?.summary ?? null : null,
        unlockFlag: reward.unlockFlag,
        modifiers: reward.modifiers.map((modifier) => ({ ...modifier })),
      };
    }),
  };
}

function completionText(condition: CompletionCondition, targetCount: number): string {
  switch (condition.kind) {
    case 'all-targets':
      return `Complete all ${targetCount} target${targetCount === 1 ? '' : 's'}`;
    case 'target-count':
      return `Complete ${condition.required} targets`;
    case 'reach-destination':
      return `Reach within ${condition.radiusMeters} m`;
    case 'survive':
      return `Hold for ${condition.durationSeconds} seconds`;
    case 'lose-wanted':
      return `Reduce wanted level to ${condition.maximumLevel}`;
    case 'choice-made':
      return `Choose ${condition.choices.join(' or ')}`;
    case 'composite':
      return `Complete ${condition.requiredObjectiveIds.length} linked objectives`;
  }
}

function createLockedProgress(): CampaignMissionProgress {
  return { state: 'locked', checkpointId: null, completedObjectives: [], choices: {} };
}

function isEndingChoice(value: string): value is 'rule' | 'expose' {
  return value === 'rule' || value === 'expose';
}
