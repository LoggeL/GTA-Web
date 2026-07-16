import { describe, expect, it } from 'vitest';

import {
  parseCampaignPanelActionDataset,
  renderCampaignPanel,
  type CampaignPanelModel,
} from '../../src/ui/CampaignPanel';

function model(): CampaignPanelModel {
  return {
    missions: [{
      id: 'past-due', number: 1, title: 'Past Due', subtitle: 'Save the garage',
      contact: 'garage', district: 'Arroyo Heights', state: 'available', gateReason: null,
      cashReward: 850, xpReward: 650,
    }],
    activeMission: null,
    activeMissionStatus: null,
    objectives: [],
    canFinishMission: false,
    contacts: { juno: 0, malik: 0, priya: 0 },
    ending: null,
    dialogue: { current: null, hasNext: false, history: [] },
    activities: [{
      id: 'street-race', name: 'Street Race', description: 'Race across Solara.',
      completions: 0, cooldownLabel: null, bestLabel: null,
      difficulties: [{ id: 'rookie', label: 'Rookie', available: true, reason: null }],
    }],
    collectibles: [
      { id: 'salvage-cache', label: 'Salvage caches', found: 0, total: 30, completed: false },
      { id: 'stunt-jump', label: 'Stunt jumps', found: 0, total: 20, completed: false },
      { id: 'signal-node', label: 'Signal nodes', found: 0, total: 10, completed: false },
    ],
  };
}

describe('CampaignPanel', () => {
  it('renders the campaign, activity, exploration, and reviewable log surfaces', () => {
    const html = renderCampaignPanel(model());
    expect(html).toContain('data-campaign-panel="true"');
    expect(html).toContain('data-mission-id="past-due"');
    expect(html).toContain('data-activity-id="street-race"');
    expect(html).toContain('data-collectible-set="salvage-cache"');
    expect(html).toContain('Mission log');
  });

  it('renders active objectives, finale choices, and checkpoint recovery', () => {
    const base = model();
    const active = { ...base.missions[0]!, state: 'active' as const };
    const html = renderCampaignPanel({
      ...base,
      activeMission: active,
      activeMissionStatus: 'failed',
      objectives: [{
        id: 'freehold:choice', title: 'Choose Solara’s future', description: 'Rule or expose.',
        type: 'choice', state: 'active', current: 0, target: 1, distanceMeters: null,
        actionLabel: null, choices: ['rule', 'expose'],
      }],
    });
    expect(html).toContain('data-campaign-action="retry-mission"');
    expect(html).toContain('data-choice="rule"');
    expect(html).toContain('data-choice="expose"');
  });

  it('parses only known typed actions', () => {
    expect(parseCampaignPanelActionDataset({ campaignAction: 'start-mission', missionId: 'past-due' }))
      .toEqual({ type: 'start-mission', missionId: 'past-due' });
    expect(parseCampaignPanelActionDataset({ campaignAction: 'objective-action', objectiveId: 'past-due:defend-garage' }))
      .toEqual({ type: 'objective-action', objectiveId: 'past-due:defend-garage' });
    expect(parseCampaignPanelActionDataset({ campaignAction: 'choose', objectiveId: 'freehold:choose-future', choice: 'rule' }))
      .toEqual({ type: 'choose', objectiveId: 'freehold:choose-future', choice: 'rule' });
    expect(parseCampaignPanelActionDataset({ campaignAction: 'start-activity', activityId: 'street-race', difficultyId: 'legend' }))
      .toEqual({ type: 'start-activity', activityId: 'street-race', difficultyId: 'legend' });
    expect(parseCampaignPanelActionDataset({ campaignAction: 'start-mission', missionId: '__proto__' })).toBeNull();
    expect(parseCampaignPanelActionDataset({ campaignAction: 'start-activity', activityId: 'unknown', difficultyId: 'rookie' })).toBeNull();
  });

  it('escapes authored and restored log text before inserting HTML', () => {
    const base = model();
    const html = renderCampaignPanel({
      ...base,
      dialogue: {
        current: null,
        hasNext: false,
        history: [{
          key: 'past-due.intro', missionTitle: 'Past Due', speaker: 'Alex',
          text: '<img src=x onerror=alert(1)>',
        }],
      },
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
