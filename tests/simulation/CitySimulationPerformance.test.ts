import { InstancedMesh, Scene } from 'three';
import { describe, expect, it } from 'vitest';

import { CitySimulation } from '../../src/simulation/CitySimulation';

function firstInstanceMatrixVersion(scene: Scene): number {
  const visualRoot = scene.getObjectByName('city-simulation-visuals');
  const mesh = visualRoot?.children.find((child): child is InstancedMesh => (
    child instanceof InstancedMesh
  ));
  if (!mesh) throw new Error('Missing pooled simulation visual');
  return mesh.instanceMatrix.version;
}

function tick(simulation: CitySimulation, deltaSeconds: number): void {
  simulation.tick({
    deltaSeconds,
    playerPosition: { x: 0, y: 0, z: 0 },
    playerHeading: 0,
  });
}

describe('CitySimulation visual cadence', () => {
  it('keeps deterministic simulation ticks while batching low-quality GPU uploads at 30 Hz', () => {
    const scene = new Scene();
    const simulation = new CitySimulation({
      seed: 'low-visual-cadence',
      quality: 'low',
      seedCombatants: false,
    });
    simulation.attach(scene);
    const initialVersion = firstInstanceMatrixVersion(scene);

    tick(simulation, 1 / 120);
    tick(simulation, 1 / 120);
    tick(simulation, 1 / 120);
    expect(simulation.getSnapshot().simulationTime).toBeCloseTo(3 / 120);
    expect(firstInstanceMatrixVersion(scene)).toBe(initialVersion);

    tick(simulation, 1 / 120);
    expect(simulation.getSnapshot().simulationTime).toBeCloseTo(4 / 120);
    expect(firstInstanceMatrixVersion(scene)).toBe(initialVersion + 1);
    simulation.dispose();
  });

  it('retains per-tick visual updates at high quality', () => {
    const scene = new Scene();
    const simulation = new CitySimulation({
      seed: 'high-visual-cadence',
      quality: 'high',
      seedCombatants: false,
    });
    simulation.attach(scene);
    const initialVersion = firstInstanceMatrixVersion(scene);
    tick(simulation, 1 / 120);
    expect(firstInstanceMatrixVersion(scene)).toBe(initialVersion + 1);
    simulation.dispose();
  });
});
