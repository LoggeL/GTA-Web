export const AUTOSAVE_INTERVAL_MILLISECONDS = 90_000;
export const AUTOSAVE_RETRY_MILLISECONDS = 15_000;

export interface AutosaveSchedule {
  readonly now: number;
  readonly lastSuccessfulSaveAt: number;
  readonly retryAt: number;
}

/** A failed event save retries on its own deadline, independent of the 90 s cadence. */
export function isAutosaveScheduleDue(schedule: Readonly<AutosaveSchedule>): boolean {
  return schedule.retryAt > 0
    ? schedule.now >= schedule.retryAt
    : schedule.now - schedule.lastSuccessfulSaveAt >= AUTOSAVE_INTERVAL_MILLISECONDS;
}
