import { describe, expect, it } from 'vitest';

import {
  VEHICLE_SPAWN,
  VEHICLE_SPAWN_HEADING,
  generateCity,
} from '../../src/game/city';
import {
  AUTHORED_INTERIORS,
  InteriorRuntime,
} from '../../src/game/InteriorRuntime';
import { createPlayerState } from '../../src/game/player';
import {
  createVehicleState,
  findVehicleExitPoint,
} from '../../src/game/vehicle';
import { WorldView } from '../../src/game/WorldView';
import type { WorldInteractionSnapshot } from '../../src/game/types';

interface InteractionHarness {
  interiorTransitionPending: boolean;
  interiorRuntime: InteriorRuntime;
  player: ReturnType<typeof createPlayerState>;
  vehicle: ReturnType<typeof createVehicleState>;
  getInteractionTarget(maximumDistance?: number): WorldInteractionSnapshot | null;
}

describe('WorldView authored entrance interaction priority', () => {
  it('selects Moreno Garage after exiting the starter car beyond the generic vehicle range', () => {
    const layout = generateCity('heatline-solara-world-v1', 'low');
    const vehicle = createVehicleState(VEHICLE_SPAWN, 'compact');
    vehicle.heading = VEHICLE_SPAWN_HEADING;
    vehicle.occupied = true;
    const exit = findVehicleExitPoint(vehicle, layout.collisions);
    expect(exit).not.toBeNull();
    if (!exit) throw new Error('Starter vehicle has no collision-safe exit');
    vehicle.occupied = false;

    const garage = AUTHORED_INTERIORS.find(({ id }) => id === 'moreno-garage');
    expect(garage).toBeDefined();
    if (!garage) throw new Error('Missing authored Moreno Garage entrance');
    const distanceToEntrance = Math.hypot(
      exit.x - garage.portal.position.x,
      exit.z - garage.portal.position.z,
    );
    expect(distanceToEntrance).toBeGreaterThan(5);
    expect(distanceToEntrance).toBeLessThan(garage.portal.interactionRadiusMeters);

    const player = createPlayerState(exit);
    player.heading = vehicle.heading;
    const harness = Object.create(WorldView.prototype) as unknown as InteractionHarness;
    Object.assign(harness, {
      interiorTransitionPending: false,
      interiorRuntime: new InteriorRuntime(),
      player,
      vehicle,
    });

    expect(harness.getInteractionTarget()).toMatchObject({
      id: garage.portal.id,
      kind: 'world',
      prompt: garage.portal.prompt,
      distanceMeters: distanceToEntrance,
    });
  });
});
