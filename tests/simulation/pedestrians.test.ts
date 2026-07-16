import { describe, expect, it } from 'vitest';

import { PedestrianSystem } from '../../src/simulation/pedestrians';
import { SimulationRandom } from '../../src/simulation/random';
import type { CrimeEvent, SimulationRoadRecipe, WitnessReportEvent } from '../../src/simulation/types';

const road: SimulationRoadRecipe = {
  id: 'pedestrian-test-road',
  position: { x: 0, y: 0, z: 0 },
  width: 500,
  depth: 18,
};

describe('pedestrian life and witnesses', () => {
  it('uses deterministic adaptive pools', () => {
    const reports: WitnessReportEvent[] = [];
    const first = new PedestrianSystem(new SimulationRandom('ped-seed'), 'low', [road], (event) => reports.push(event));
    const second = new PedestrianSystem(new SimulationRandom('ped-seed'), 'low', [road], () => undefined);
    expect(first.getSnapshot()).toEqual(second.getSnapshot());
    expect(first.getSnapshot()).toHaveLength(18);
    first.setQuality('high');
    expect(first.getSnapshot()).toHaveLength(45);
  });

  it('flees nearby serious crime, then submits one witness report', () => {
    const reports: WitnessReportEvent[] = [];
    const system = new PedestrianSystem(new SimulationRandom('witness-seed'), 'low', [road], (event) => reports.push(event));
    const witness = system.getSnapshot()[0];
    if (!witness) {
      throw new Error('Missing pedestrian');
    }
    const crime: CrimeEvent = {
      id: 'crime-test',
      kind: 'assault',
      sourceId: 'player',
      position: { ...witness.position },
      severity: 3,
      simulationTime: 0,
    };
    system.observeCrime(crime);
    expect(system.getSnapshot().find((pedestrian) => pedestrian.id === witness.id)?.behavior).toBe('flee');

    for (let frame = 0; frame < 60; frame += 1) {
      system.tick(0.1, frame * 0.1);
    }
    expect(reports.some((report) => report.crimeId === crime.id && report.witnessId === witness.id)).toBe(true);
    const reportCount = reports.length;
    for (let frame = 0; frame < 20; frame += 1) {
      system.tick(0.1, 6 + frame * 0.1);
    }
    expect(reports).toHaveLength(reportCount);
  });

  it('enters flee state through the general panic hook', () => {
    const system = new PedestrianSystem(new SimulationRandom('panic-seed'), 'low', [road], () => undefined);
    const pedestrian = system.getSnapshot()[0];
    if (!pedestrian) {
      throw new Error('Missing pedestrian');
    }
    system.triggerPanic(pedestrian.position, 5, 2);
    expect(system.getSnapshot()[0]?.behavior).toBe('flee');
    for (let frame = 0; frame < 23; frame += 1) {
      system.tick(0.1, frame * 0.1);
    }
    expect(system.getSnapshot()[0]?.behavior).toBe('wander');
  });

  it('uses connected nav, deterministic temperaments, and obstacle recovery', () => {
    const first = new PedestrianSystem(new SimulationRandom('ped-nav'), 'low', [road], () => undefined);
    const second = new PedestrianSystem(new SimulationRandom('ped-nav'), 'low', [road], () => undefined);
    expect(first.getNavigationGraph().nodes.length).toBeGreaterThan(20);
    expect(first.getNpcSnapshot().map(({ temperament }) => temperament).slice(0, 6)).toEqual([
      'calm', 'cautious', 'nervous', 'calm', 'cautious', 'nervous',
    ]);
    for (let frame = 0; frame < 200; frame += 1) {
      const pedestrian = first.getNpcSnapshot()[0];
      const obstacle = pedestrian
        ? [{ x: pedestrian.position.x, z: pedestrian.position.z, radius: 1.4 }]
        : [];
      first.tick(0.1, frame * 0.1, { obstacles: obstacle });
      second.tick(0.1, frame * 0.1, { obstacles: obstacle });
      expect(first.getNpcSnapshot()).toEqual(second.getNpcSnapshot());
    }
    expect(first.getNpcSnapshot().every((pedestrian) => (
      Number.isFinite(pedestrian.position.x)
      && Number.isFinite(pedestrian.position.z)
      && pedestrian.recoveryCount <= 4
    ))).toBe(true);
  });

  it('reacts to non-visual noise without fabricating a witness report', () => {
    const reports: WitnessReportEvent[] = [];
    const system = new PedestrianSystem(
      new SimulationRandom('ped-noise'),
      'low',
      [road],
      (event) => reports.push(event),
    );
    const pedestrian = system.getSnapshot()[0];
    if (!pedestrian) throw new Error('Missing pedestrian');
    system.hearNoise({
      id: 'noise-1',
      position: pedestrian.position,
      radius: 10,
      severity: 4,
      directThreat: true,
    });
    expect(system.getNpcSnapshot()[0]).toMatchObject({
      state: 'flee',
      reaction: 'flee',
      pendingCrimeId: null,
    });
    for (let frame = 0; frame < 50; frame += 1) system.tick(0.1, frame * 0.1);
    expect(reports).toHaveLength(0);
  });
});
