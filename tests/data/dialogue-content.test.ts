import { describe, expect, it } from 'vitest';

import { DIALOGUE, MISSIONS } from '../../src/data/missions';
import { DialogueRuntime } from '../../src/runtime/DialogueRuntime';

describe('authored dialogue content', () => {
  it('owns every non-empty line through exactly one mission sequence', () => {
    const keys = DIALOGUE.map((entry) => entry.key);
    const missionKeys = MISSIONS.flatMap((mission) => mission.dialogueKeys);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(missionKeys).size).toBe(missionKeys.length);
    expect(new Set(missionKeys)).toEqual(new Set(keys));
    for (const entry of DIALOGUE) {
      expect(entry.key.startsWith(`${entry.missionId}.`)).toBe(true);
      expect(entry.text.trim().length).toBeGreaterThan(20);
    }
  });

  it('guards only the two mutually exclusive finale lines', () => {
    const guarded = DIALOGUE.filter((entry) => entry.branch !== undefined);

    expect(guarded.map((entry) => [entry.key, entry.branch])).toEqual([
      ['freehold.rule', 'rule'],
      ['freehold.expose', 'expose'],
    ]);
  });

  it('starts all twelve mission sequences without missing authored content', () => {
    for (const mission of MISSIONS) {
      const runtime = new DialogueRuntime();
      const result = runtime.startMission(mission.id);

      expect(result.missingKeys, mission.id).toEqual([]);
      expect(result.lineCount, mission.id).toBe(
        mission.id === 'freehold' ? mission.dialogueKeys.length - 2 : mission.dialogueKeys.length,
      );
    }
  });
});
