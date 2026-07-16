export interface StolenVehicleIdentity {
  readonly instanceId: string;
  readonly nextSequence: number;
}

const TRAFFIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

/** Creates a stable save-safe identity while skipping every already-owned id. */
export function createUniqueStolenVehicleIdentity(
  trafficId: string,
  reservedInstanceIds: ReadonlySet<string>,
  startingSequence = 0,
): StolenVehicleIdentity {
  if (!TRAFFIC_ID_PATTERN.test(trafficId)) {
    throw new TypeError('traffic vehicle id must use a save-safe identifier');
  }
  if (!Number.isSafeInteger(startingSequence) || startingSequence < 0) {
    throw new RangeError('stolen vehicle sequence must be a non-negative safe integer');
  }
  let sequence = startingSequence;
  while (sequence < Number.MAX_SAFE_INTEGER) {
    const instanceId = `stolen-${trafficId}-${sequence.toString().padStart(3, '0')}`;
    sequence += 1;
    if (!reservedInstanceIds.has(instanceId)) {
      return { instanceId, nextSequence: sequence };
    }
  }
  throw new RangeError('stolen vehicle identity space is exhausted');
}
