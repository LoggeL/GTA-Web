import { describe, expect, it } from 'vitest';

import type { GpsRouteSegment, NavigationPoint } from '../../src/navigation/types';
import {
  DEFAULT_MAP_BOUNDS,
  MapRenderer,
  buildMapFogCells,
  clipSegmentToBounds,
  createMapProjection,
  createMapRenderModel,
  projectMapPoint,
  renderMapSvg,
  selectMapMarkers,
  selectMapRouteSegments,
  type MapMarkerInput,
} from '../../src/ui/MapRenderer';

function routeSegment(
  index: number,
  from: NavigationPoint,
  to: NavigationPoint,
): GpsRouteSegment {
  return {
    index,
    from,
    to,
    distanceMeters: Math.hypot(to.x - from.x, to.z - from.z),
    headingRadians: Math.atan2(to.x - from.x, to.z - from.z),
  };
}

describe('MapRenderer projection and clipping', () => {
  it('fits world coordinates into a centered responsive viewport', () => {
    const projection = createMapProjection(DEFAULT_MAP_BOUNDS, {
      width: 1_000,
      height: 500,
    }, 50);

    expect(projection.scale).toBeCloseTo(1 / 3);
    expect(projection.offsetX).toBeCloseTo(300);
    expect(projection.offsetY).toBeCloseTo(50);
    expect(projectMapPoint({ x: -600, z: -600 }, projection)).toEqual({ x: 300, y: 50 });
    expect(projectMapPoint({ x: 0, z: 0 }, projection)).toEqual({ x: 500, y: 250 });
    expect(projectMapPoint({ x: 600, z: 600 }, projection)).toEqual({ x: 700, y: 450 });
  });

  it('clips crossing route lines and rejects lines outside the city', () => {
    expect(clipSegmentToBounds({
      from: { x: -1_000, z: 0 },
      to: { x: 1_000, z: 0 },
    }, DEFAULT_MAP_BOUNDS)).toEqual({
      from: { x: -600, z: 0 },
      to: { x: 600, z: 0 },
    });
    expect(clipSegmentToBounds({
      from: { x: -100, z: 700 },
      to: { x: 100, z: 700 },
    }, DEFAULT_MAP_BOUNDS)).toBeNull();
  });
});

describe('MapRenderer visibility models', () => {
  it('builds exact 256m fog cells and marks only discovered cells clear', () => {
    const fog = buildMapFogCells(
      { minX: -256, maxX: 256, minZ: -256, maxZ: 256 },
      ['cell:0:0'],
    );

    expect(fog.map((cell) => cell.cellId)).toEqual([
      'cell:-1:-1',
      'cell:0:-1',
      'cell:-1:0',
      'cell:0:0',
    ]);
    expect(fog.filter((cell) => cell.discovered).map((cell) => cell.cellId)).toEqual(['cell:0:0']);
    expect(fog.find((cell) => cell.cellId === 'cell:-1:-1')?.bounds).toEqual({
      minX: -256,
      maxX: 0,
      minZ: -256,
      maxZ: 0,
    });
  });

  it('applies marker filters, discovery, mission pins, and map bounds deterministically', () => {
    const markers: readonly MapMarkerInput[] = [
      {
        id: 'shop', kind: 'shop', label: 'Market', position: { x: 10, z: 10 },
        cellId: 'cell:0:0', reveal: 'discovered',
      },
      {
        id: 'mission', kind: 'mission', label: 'Night Train', position: { x: 300, z: 10 },
        cellId: 'cell:1:0', reveal: 'discovered', missionId: 'night-train',
      },
      {
        id: 'home', kind: 'safehouse', label: 'Garage', position: { x: 20, z: 20 },
        cellId: 'cell:0:0', reveal: 'discovered',
      },
      {
        id: 'always', kind: 'activity', label: 'Race', position: { x: -20, z: 20 },
        cellId: 'cell:-1:0', reveal: 'always',
      },
      {
        id: 'fogged', kind: 'custom', label: 'Unknown', position: { x: 300, z: 300 },
        cellId: 'cell:1:1', reveal: 'discovered',
      },
      {
        id: 'outside', kind: 'activity', label: 'Outside', position: { x: 900, z: 0 },
        cellId: 'cell:3:0', reveal: 'always',
      },
    ];

    expect(selectMapMarkers(
      markers,
      { shop: false },
      ['cell:0:0'],
      ['night-train'],
      DEFAULT_MAP_BOUNDS,
    ).map((marker) => marker.id)).toEqual(['always', 'home', 'mission']);
  });

  it('selects and clips only the next configured GPS segments', () => {
    const segments = [
      routeSegment(3, { x: 0, z: 0 }, { x: 500, z: 0 }),
      routeSegment(0, { x: -500, z: -100 }, { x: -400, z: -100 }),
      routeSegment(2, { x: -500, z: 0 }, { x: 0, z: 0 }),
      routeSegment(1, { x: -800, z: 0 }, { x: -500, z: 0 }),
    ];

    const selected = selectMapRouteSegments(segments, 1, 2, DEFAULT_MAP_BOUNDS);
    expect(selected.map((segment) => segment.index)).toEqual([1, 2]);
    expect(selected[0]?.from).toEqual({ x: -600, z: 0 });
    expect(selected[0]?.to).toEqual({ x: -500, z: 0 });
  });
});

describe('MapRenderer model and SVG output', () => {
  const state = {
    player: { position: { x: -248, z: 248 }, heading: Math.PI / 2 },
    discoveredCellIds: ['cell:-1:0'] as const,
    markers: [{
      id: 'contact',
      kind: 'mission',
      label: 'A&B <Meet>',
      position: { x: -220, z: 220 },
      cellId: 'cell:-1:0',
      reveal: 'discovered',
      missionId: 'first-job',
    }] as const,
    waypoint: { label: 'Depot', position: { x: 200, z: 200 } },
    routeSegments: [
      routeSegment(0, { x: -248, z: 248 }, { x: 0, z: 248 }),
      routeSegment(1, { x: 0, z: 248 }, { x: 200, z: 200 }),
    ],
    routeSegmentIndex: 0,
  };

  it('models all four districts, authored roads, heading, fog, and an accessible summary', () => {
    const model = createMapRenderModel(state, { width: 640, height: 360 });

    expect(model.districts).toHaveLength(4);
    expect(model.roads).toHaveLength(50);
    expect(model.fogCells).toHaveLength(36);
    expect(model.fogCells.filter((cell) => cell.discovered)).toHaveLength(1);
    expect(model.player?.headingLabel).toBe('west');
    expect(model.player?.rotationDegrees).toBe(270);
    expect(model.markers.map((marker) => marker.id)).toEqual(['contact']);
    expect(model.waypoint?.label).toBe('Depot');
    expect(model.routeSegments.map((segment) => segment.index)).toEqual([0, 1]);
    expect(model.summary).toMatchObject({
      playerDistrict: 'Arroyo Heights',
      playerHeading: 'west',
      discoveredCellCount: 1,
      totalCellCount: 36,
      visibleMarkerLabels: ['A&B <Meet>'],
      waypointLabel: 'Depot',
      routeSegmentCount: 2,
    });
    expect(model.summary.text).toContain('Player in Arroyo Heights, heading west.');
  });

  it('emits responsive, asset-free, escaped SVG and draws into a measured host', () => {
    const target = {
      innerHTML: '',
      getBoundingClientRect: () => ({ width: 320, height: 180 }),
    } as unknown as HTMLElement;
    const renderer = new MapRenderer(target, { roads: [] });
    const firstModel = renderer.draw(state);
    const firstSvg = target.innerHTML;
    const directSvg = renderMapSvg(firstModel);

    expect(firstModel.projection.viewport).toEqual({ width: 320, height: 180 });
    expect(firstSvg).toBe(directSvg);
    expect(firstSvg).toContain('role="img"');
    expect(firstSvg).toContain('viewBox="0 0 320 180"');
    expect(firstSvg).toContain('width="100%" height="100%"');
    expect(firstSvg).toContain('data-player="true"');
    expect(firstSvg).toContain('data-waypoint="true"');
    expect(firstSvg).toContain('data-marker-id="contact"');
    expect(firstSvg).toContain('A&amp;B &lt;Meet&gt;');
    expect(firstSvg).not.toContain('A&B <Meet>');

    renderer.draw(state);
    expect(target.innerHTML).toBe(firstSvg);
    renderer.clear();
    expect(target.innerHTML).toBe('');
  });
});
