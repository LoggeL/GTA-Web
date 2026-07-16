import { describe, expect, it } from 'vitest';

import { createUniqueStolenVehicleIdentity } from '../../src/game/vehicleIdentity';

describe('stolen vehicle identity', () => {
  it('skips ids already owned before and after a reload', () => {
    const owned = new Set([
      'moreno-rook',
      'stolen-traffic-00-000',
      'stolen-traffic-00-001',
    ]);
    expect(createUniqueStolenVehicleIdentity('traffic-00', owned, 0)).toEqual({
      instanceId: 'stolen-traffic-00-002',
      nextSequence: 3,
    });
  });

  it('rejects unsafe traffic ids and invalid sequence state', () => {
    expect(() => createUniqueStolenVehicleIdentity('__proto__ space', new Set())).toThrow();
    expect(() => createUniqueStolenVehicleIdentity('traffic-01', new Set(), -1)).toThrow();
  });
});
