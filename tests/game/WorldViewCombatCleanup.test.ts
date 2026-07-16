import { describe, expect, it } from 'vitest';

import { WorldView } from '../../src/game/WorldView';
import { CitySimulation } from '../../src/simulation/CitySimulation';

interface WorldViewCombatHarness {
  citySimulation: CitySimulation;
  disposed: boolean;
}

function worldViewCombatHarness(citySimulation: CitySimulation): WorldView {
  const world = Object.create(WorldView.prototype) as WorldView;
  Object.assign(world as unknown as WorldViewCombatHarness, {
    citySimulation,
    disposed: false,
  });
  return world;
}

describe('WorldView combat resolution cleanup', () => {
  it('tracks surrender and incapacitation, then despawns and frees the pooled actor', () => {
    const simulation = new CitySimulation({
      seed: 'world-combat-cleanup',
      quality: 'low',
      seedCombatants: false,
    });
    simulation.setActorLimits({ traffic: 0, pedestrians: 0, combat: 2 });
    const surrenderingId = simulation.spawnEnemy('brawler', { x: 0, y: 0, z: -2 });
    if (!surrenderingId) throw new Error('Expected surrender target');
    simulation.damageEnemy(surrenderingId, 90, 'player', { x: 0, y: 0, z: 0 });
    for (let frame = 0; frame < 30; frame += 1) {
      simulation.tick({
        deltaSeconds: 0.1,
        playerPosition: { x: 0, y: 0, z: 0 },
        playerHeading: 0,
        playerMovement: 1,
        playerNoise: 1,
        input: { threatening: true },
      });
    }

    const incapacitatedId = simulation.spawnEnemy('gunner', { x: 4, y: 0, z: -8 });
    if (!incapacitatedId) throw new Error('Expected incapacitation target');
    simulation.damageEnemy(incapacitatedId, 1_000);
    const world = worldViewCombatHarness(simulation);

    expect(world.getResolvedCombatantIds()).toEqual([surrenderingId, incapacitatedId]);
    expect(world.despawnCombatant(surrenderingId)).toBe(true);
    expect(world.getResolvedCombatantIds()).toEqual([incapacitatedId]);
    expect(world.despawnCombatant(surrenderingId)).toBe(false);
    expect(simulation.spawnEnemy('heavy', { x: 8, y: 0, z: -8 })).toBe(surrenderingId);

    simulation.dispose();
  });
});
