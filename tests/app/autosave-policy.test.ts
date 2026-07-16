import { describe, expect, it } from 'vitest';

import {
  AUTOSAVE_INTERVAL_MILLISECONDS,
  AUTOSAVE_RETRY_MILLISECONDS,
  isAutosaveScheduleDue,
} from '../../src/app/autosave-policy';

describe('autosave schedule', () => {
  it('uses the normal 90-second interval after a successful write', () => {
    expect(isAutosaveScheduleDue({
      now: AUTOSAVE_INTERVAL_MILLISECONDS - 1,
      lastSuccessfulSaveAt: 0,
      retryAt: 0,
    })).toBe(false);
    expect(isAutosaveScheduleDue({
      now: AUTOSAVE_INTERVAL_MILLISECONDS,
      lastSuccessfulSaveAt: 0,
      retryAt: 0,
    })).toBe(true);
  });

  it('retries a failed event save after 15 seconds even before the normal interval', () => {
    const retryAt = 5_000 + AUTOSAVE_RETRY_MILLISECONDS;
    expect(isAutosaveScheduleDue({
      now: retryAt - 1,
      lastSuccessfulSaveAt: 4_900,
      retryAt,
    })).toBe(false);
    expect(isAutosaveScheduleDue({
      now: retryAt,
      lastSuccessfulSaveAt: 4_900,
      retryAt,
    })).toBe(true);
  });
});
