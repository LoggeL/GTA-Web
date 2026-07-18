import { describe, expect, it } from 'vitest';

import {
  TRAFFIC_SIGNAL_TIMING,
  TrafficSignalSystem,
} from '../../src/simulation/traffic-signals';
import type { SimulationRoadRecipe } from '../../src/simulation/types';

const horizontal: SimulationRoadRecipe = {
  id: 'horizontal-main',
  position: { x: 0, y: 0, z: 0 },
  width: 100,
  depth: 12,
  major: true,
};
const vertical: SimulationRoadRecipe = {
  id: 'vertical-main',
  position: { x: 0, y: 0, z: 0 },
  width: 12,
  depth: 100,
  major: true,
};

describe('TrafficSignalSystem', () => {
  it('discovers only true horizontal/vertical crossings in stable graph order', () => {
    const roads: readonly SimulationRoadRecipe[] = [
      { ...horizontal, id: 'horizontal-south', position: { x: 0, y: 0, z: 20 } },
      { ...vertical, id: 'vertical-east', position: { x: 20, y: 0, z: 0 } },
      horizontal,
      vertical,
      {
        id: 'parallel-end',
        position: { x: 100, y: 0, z: 0 },
        width: 100,
        depth: 12,
      },
      {
        id: 'square-plaza',
        position: { x: 0, y: 0, z: 0 },
        width: 20,
        depth: 20,
      },
    ];
    const first = new TrafficSignalSystem(roads).getSnapshot();
    const reordered = new TrafficSignalSystem([...roads].reverse()).getSnapshot();

    expect(first).toEqual(reordered);
    expect(first.junctions.map(({ id }) => id)).toEqual([
      'road-node:0,0',
      'road-node:0,20',
      'road-node:20,0',
      'road-node:20,20',
    ]);
    expect(first.junctions[0]).toMatchObject({
      position: { x: 0, y: 0, z: 0 },
      horizontalRoadIds: ['horizontal-main'],
      verticalRoadIds: ['vertical-main'],
    });
  });

  it('assigns deterministic bounded offsets so a multi-junction city is not synchronized', () => {
    const roads: readonly SimulationRoadRecipe[] = [
      horizontal,
      { ...horizontal, id: 'horizontal-south', position: { x: 0, y: 0, z: 20 } },
      vertical,
      { ...vertical, id: 'vertical-east', position: { x: 20, y: 0, z: 0 } },
    ];
    const junctions = new TrafficSignalSystem(roads).getSnapshot().junctions;
    const offsets = junctions.map(({ offsetSeconds }) => offsetSeconds);

    expect(offsets).toEqual([0, 7.5, 15, 22.5]);
    expect(new Set(offsets).size).toBe(junctions.length);
    expect(offsets.every((offset) => offset >= 0 && offset < TRAFFIC_SIGNAL_TIMING.cycleSeconds)).toBe(true);
    expect(new Set(junctions.map(({ phase }) => phase)).size).toBeGreaterThan(1);
  });

  it('uses half-open phases with exact green, yellow, and all-red boundaries', () => {
    const signals = new TrafficSignalSystem([horizontal, vertical]);
    const id = signals.getSnapshot().junctions[0]?.id ?? '';

    expect(signals.aspectFor(id, 'horizontal')).toBe('green');
    expect(signals.aspectFor(id, 'vertical')).toBe('red');

    signals.tick(TRAFFIC_SIGNAL_TIMING.greenSeconds - 0.001);
    expect(signals.getSnapshot().junctions[0]?.phase).toBe('horizontal-green');
    signals.tick(0.001);
    expect(signals.getSnapshot().junctions[0]?.phase).toBe('horizontal-yellow');
    expect(signals.aspectFor(id, horizontal)).toBe('yellow');

    signals.tick(TRAFFIC_SIGNAL_TIMING.yellowSeconds);
    expect(signals.getSnapshot().junctions[0]?.phase).toBe('all-red-to-vertical');
    expect(signals.aspectFor(id, 'horizontal')).toBe('red');
    expect(signals.aspectFor(id, 'vertical')).toBe('red');

    signals.tick(TRAFFIC_SIGNAL_TIMING.allRedSeconds);
    expect(signals.getSnapshot().junctions[0]?.phase).toBe('vertical-green');
    signals.tick(TRAFFIC_SIGNAL_TIMING.greenSeconds);
    expect(signals.getSnapshot().junctions[0]?.phase).toBe('vertical-yellow');
    signals.tick(TRAFFIC_SIGNAL_TIMING.yellowSeconds);
    expect(signals.getSnapshot().junctions[0]?.phase).toBe('all-red-to-horizontal');
    signals.tick(TRAFFIC_SIGNAL_TIMING.allRedSeconds);
    expect(signals.getSnapshot().junctions[0]?.phase).toBe('horizontal-green');
  });

  it('maps a road approach to its orientation and rejects roads outside the junction', () => {
    const signals = new TrafficSignalSystem([horizontal, vertical]);
    const id = signals.getSnapshot().junctions[0]?.id ?? '';

    expect(signals.aspectFor(id, horizontal)).toBe(signals.aspectFor(id, 'horizontal'));
    expect(signals.aspectFor(id, vertical)).toBe(signals.aspectFor(id, 'vertical'));
    expect(() => signals.aspectFor(id, { id: 'missing-road' })).toThrow(RangeError);
  });

  it('reduces very large deltas modulo one cycle in constant bounded state', () => {
    const large = new TrafficSignalSystem([horizontal, vertical]);
    const reference = new TrafficSignalSystem([horizontal, vertical]);
    const remainder = 8.25;

    large.tick(TRAFFIC_SIGNAL_TIMING.cycleSeconds * 1_000_000 + remainder);
    reference.tick(remainder);

    expect(large.getSnapshot()).toEqual(reference.getSnapshot());
    expect(large.getSnapshot().cycleClockSeconds).toBeLessThan(TRAFFIC_SIGNAL_TIMING.cycleSeconds);
  });

  it('returns deeply frozen snapshots that cannot corrupt subsequent reads', () => {
    const signals = new TrafficSignalSystem([horizontal, vertical]);
    const snapshot = signals.getSnapshot();
    const junction = snapshot.junctions[0];

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.junctions)).toBe(true);
    expect(Object.isFrozen(junction)).toBe(true);
    expect(Object.isFrozen(junction?.position)).toBe(true);
    expect(Object.isFrozen(junction?.horizontalRoadIds)).toBe(true);
    expect(() => {
      (snapshot.junctions as TrafficSignalJunctionSnapshotForMutation[]).push({} as TrafficSignalJunctionSnapshotForMutation);
    }).toThrow(TypeError);
    expect(signals.getSnapshot()).toEqual(snapshot);
  });

  it('fails fast on invalid roads, deltas, junctions, and approaches', () => {
    expect(() => new TrafficSignalSystem([{ ...horizontal, id: ' ' }])).toThrow(TypeError);
    expect(() => new TrafficSignalSystem([horizontal, { ...horizontal }])).toThrow(/unique ids/i);
    expect(() => new TrafficSignalSystem([{ ...horizontal, width: 0 }])).toThrow(RangeError);
    expect(() => new TrafficSignalSystem([{
      ...horizontal,
      position: { ...horizontal.position, x: Number.NaN },
    }])).toThrow(RangeError);

    const signals = new TrafficSignalSystem([horizontal, vertical]);
    const id = signals.getSnapshot().junctions[0]?.id ?? '';
    expect(() => signals.tick(-0.01)).toThrow(RangeError);
    expect(() => signals.tick(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => signals.aspectFor('missing', 'horizontal')).toThrow(RangeError);
    expect(() => signals.aspectFor(id, 'diagonal' as 'horizontal')).toThrow(TypeError);
    expect(() => signals.aspectFor(id, null as unknown as 'horizontal')).toThrow(TypeError);
  });
});

type TrafficSignalJunctionSnapshotForMutation = ReturnType<TrafficSignalSystem['getSnapshot']>['junctions'][number];
