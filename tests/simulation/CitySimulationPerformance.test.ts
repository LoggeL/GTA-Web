import { InstancedMesh, Matrix4, Mesh, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { CitySimulation } from '../../src/simulation/CitySimulation';

function firstVisibleVisualState(scene: Scene): readonly number[] {
  const visualRoot = scene.getObjectByName('city-simulation-visuals');
  const mesh = visualRoot?.children.find((child): child is Mesh => (
    child.visible && child instanceof Mesh
  ));
  if (!mesh) throw new Error('Missing pooled simulation visual');
  if (mesh instanceof InstancedMesh) {
    const matrix = new Matrix4();
    mesh.getMatrixAt(0, matrix);
    return [...matrix.elements];
  }
  const position = mesh.geometry.getAttribute('position');
  const sampledVertices = Math.min(4, mesh.geometry.drawRange.count);
  const state = [mesh.geometry.drawRange.count];
  for (let vertex = 0; vertex < sampledVertices; vertex += 1) {
    state.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
  }
  return state;
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
    const initialMatrix = firstVisibleVisualState(scene);

    tick(simulation, 1 / 120);
    tick(simulation, 1 / 120);
    tick(simulation, 1 / 120);
    expect(simulation.getSnapshot().simulationTime).toBeCloseTo(3 / 120);
    expect(firstVisibleVisualState(scene)).toEqual(initialMatrix);

    tick(simulation, 1 / 120);
    expect(simulation.getSnapshot().simulationTime).toBeCloseTo(4 / 120);
    expect(firstVisibleVisualState(scene)).not.toEqual(initialMatrix);
    simulation.dispose();
  });

  it('retains per-frame visual updates on the high-quality advance path', () => {
    const scene = new Scene();
    const simulation = new CitySimulation({
      seed: 'high-visual-cadence',
      quality: 'high',
      seedCombatants: false,
    });
    simulation.attach(scene);
    const initialMatrix = firstVisibleVisualState(scene);
    const snapshotSpy = vi.spyOn(simulation, 'getSnapshot');
    simulation.advance({
      deltaSeconds: 1 / 120,
      playerPosition: { x: 0, y: 0, z: 0 },
      playerHeading: 0,
    });
    expect(snapshotSpy).toHaveBeenCalledOnce();
    expect(firstVisibleVisualState(scene)).not.toEqual(initialMatrix);
    simulation.dispose();
  });

  it('materializes low-quality snapshots only when the visual upload is due', () => {
    const scene = new Scene();
    const simulation = new CitySimulation({
      seed: 'snapshot-free-low-runtime',
      quality: 'low',
      seedCombatants: false,
    });
    simulation.attach(scene);
    const snapshotSpy = vi.spyOn(simulation, 'getSnapshot');
    const context = {
      deltaSeconds: 1 / 120,
      playerPosition: { x: 0, y: 0, z: 0 },
      playerHeading: 0,
    };

    simulation.advance(context);
    simulation.advance(context);
    simulation.advance(context);
    expect(snapshotSpy).not.toHaveBeenCalled();

    simulation.advance(context);
    expect(snapshotSpy).toHaveBeenCalledOnce();
    simulation.dispose();
  });
});
