import { describe, expect, it } from 'vitest';

import {
  SAVE_SLOT_ACTION_MATRIX,
  getSaveSlotActions,
  isSaveImportDestinationEligible,
  type SaveSlotStatus,
  type SaveSlotSummary,
} from '../../src/ui/GameUI';

const summary = (
  status: SaveSlotStatus,
  canExport?: boolean,
): SaveSlotSummary => ({
  slot: 1,
  status,
  canExport,
});

describe('GameUI save-slot action matrix', () => {
  it('offers only actions that are safe for each persistence status', () => {
    expect(SAVE_SLOT_ACTION_MATRIX).toEqual({
      empty: ['new'],
      ready: ['continue', 'export', 'delete'],
      recovered: ['continue', 'export', 'delete'],
      corrupt: ['delete'],
      'unsupported-version': ['export', 'delete'],
      unavailable: [],
    });
  });

  it('never offers Continue for a corrupt or future-version snapshot', () => {
    expect(getSaveSlotActions(summary('corrupt'))).toEqual(['delete']);
    expect(getSaveSlotActions(summary('unsupported-version'))).toEqual(['export', 'delete']);
    expect(getSaveSlotActions(summary('unavailable'))).toEqual([]);
  });

  it('removes Export when no intact snapshot is available', () => {
    expect(getSaveSlotActions(summary('ready', false))).toEqual(['continue', 'delete']);
    expect(getSaveSlotActions(summary('unsupported-version', false))).toEqual(['delete']);
  });

  it('does not mutate the canonical status matrix when filtering an individual slot', () => {
    getSaveSlotActions(summary('ready', false));
    expect(SAVE_SLOT_ACTION_MATRIX.ready).toEqual(['continue', 'export', 'delete']);
  });

  it('protects corrupt and future-version slots from import replacement', () => {
    expect(isSaveImportDestinationEligible('empty')).toBe(true);
    expect(isSaveImportDestinationEligible('ready')).toBe(true);
    expect(isSaveImportDestinationEligible('recovered')).toBe(true);
    expect(isSaveImportDestinationEligible('corrupt')).toBe(false);
    expect(isSaveImportDestinationEligible('unsupported-version')).toBe(false);
    expect(isSaveImportDestinationEligible('unavailable')).toBe(false);
  });
});
