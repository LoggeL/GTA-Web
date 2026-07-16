import { describe, expect, it } from 'vitest';

import { districtAt } from '../../src/game/city';
import {
  AUTHORED_INTERIORS,
  DEFAULT_INTERIOR_TRANSITION_MILLISECONDS,
  INTERIOR_RUNTIME_SNAPSHOT_VERSION,
  InteriorRuntime,
} from '../../src/game/InteriorRuntime';
import type {
  InteriorActorState,
  InteriorDefinition,
  InteriorLoadRequest,
  InteriorRuntimeSnapshotV1,
  InteriorTransform,
} from '../../src/game/InteriorRuntime';

function actorAt(
  position: InteriorActorState['position'],
  overrides: Partial<InteriorActorState> = {},
): InteriorActorState {
  return {
    position,
    heading: 0,
    mode: 'on-foot',
    grounded: true,
    ...overrides,
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function immediateRuntime(
  overrides: ConstructorParameters<typeof InteriorRuntime>[0] = {},
): InteriorRuntime {
  return new InteriorRuntime({
    minimumTransitionMilliseconds: 0,
    wait: async () => undefined,
    ...overrides,
  });
}

function garageActor(
  overrides: Partial<InteriorActorState> = {},
): InteriorActorState {
  const garage = AUTHORED_INTERIORS[0];
  if (!garage) throw new Error('Missing authored garage');
  return actorAt(garage.portal.position, overrides);
}

async function enterGarage(
  runtime: InteriorRuntime,
  actor: InteriorActorState = garageActor(),
): Promise<void> {
  const result = await runtime.enter('moreno-garage-entry', actor);
  expect(result.success).toBe(true);
}

describe('authored interior definitions', () => {
  it('provides the garage, three contact hubs, and finale tower in stable order', () => {
    expect(AUTHORED_INTERIORS.map((definition) => definition.id)).toEqual([
      'moreno-garage',
      'juno-grid',
      'malik-office',
      'priya-workshop',
      'syndicate-tower',
    ]);
    expect(AUTHORED_INTERIORS.map((definition) => definition.portal.district)).toEqual([
      'arroyo-heights',
      'neon-strand',
      'alta-vista',
      'breakwater',
      'alta-vista',
    ]);
    expect(AUTHORED_INTERIORS.map((definition) => definition.portal.cellId)).toEqual([
      'cell:-1:0',
      'cell:-2:-2',
      'cell:1:-2',
      'cell:1:1',
      'cell:1:-1',
    ]);
  });

  it('gives every separate scene compact collision and low-poly visual recipes', () => {
    for (const definition of AUTHORED_INTERIORS) {
      expect(districtAt(
        definition.portal.position.x,
        definition.portal.position.z,
      )).toBe(definition.portal.district);
      expect(definition.scene.id).toBe(definition.id);
      expect(definition.portal.interiorId).toBe(definition.id);
      expect(definition.scene.collisions.length).toBeGreaterThanOrEqual(6);
      expect(definition.scene.visuals.length).toBeGreaterThanOrEqual(8);
      expect(new Set(definition.scene.visuals.map((entry) => entry.id)).size).toBe(
        definition.scene.visuals.length,
      );
      expect(definition.scene.entrySpawn.position.y).toBe(0);
      expect(definition.scene.exitPosition.z).toBeGreaterThan(
        definition.scene.entrySpawn.position.z,
      );
    }
    expect(new Set(AUTHORED_INTERIORS.map((entry) => entry.scene)).size).toBe(5);
  });
});

describe('InteriorRuntime interaction eligibility', () => {
  it('selects the nearest eligible exterior portal deterministically', () => {
    const runtime = immediateRuntime();
    const garage = AUTHORED_INTERIORS.find(
      (definition) => definition.id === 'moreno-garage',
    );
    expect(garage).toBeDefined();
    const actor = garageActor({
      position: {
        x: (garage?.portal.position.x ?? 0) + 0.75,
        y: garage?.portal.position.y ?? 0,
        z: garage?.portal.position.z ?? 0,
      },
    });

    expect(runtime.nearestEligiblePortal(actor)).toMatchObject({
      eligible: true,
      reason: 'eligible',
      portalId: 'moreno-garage-entry',
      interiorId: 'moreno-garage',
      distanceMeters: 0.75,
    });
    expect(runtime.nearestEligiblePortal(actor, 0.5)).toBeNull();
    expect(() => runtime.nearestEligiblePortal(actor, -1)).toThrow(
      /maximumDistanceMeters/,
    );
  });

  it('reports actionable reasons for invalid, distant, airborne, and vehicle actors', () => {
    const runtime = immediateRuntime();

    expect(runtime.evaluatePortal('missing', garageActor()).reason).toBe('unknown-portal');
    expect(runtime.evaluatePortal(
      'moreno-garage-entry',
      garageActor({ position: { x: -200, y: 0, z: 200 } }),
    ).reason).toBe('too-far');
    expect(runtime.evaluatePortal(
      'moreno-garage-entry',
      garageActor({ grounded: false }),
    ).reason).toBe('airborne');
    expect(runtime.evaluatePortal(
      'moreno-garage-entry',
      garageActor({ mode: 'vehicle' }),
    ).reason).toBe('vehicle');
    expect(runtime.evaluatePortal(
      'moreno-garage-entry',
      garageActor({ heading: Number.NaN }),
    ).reason).toBe('invalid-actor');
  });

  it('supports campaign-owned portal locks without hiding authored definitions', () => {
    const runtime = immediateRuntime({
      isPortalUnlocked: (definition) => definition.id !== 'syndicate-tower',
    });
    const tower = runtime.definitionForPortal('syndicate-command-tower-entry');
    if (!tower) throw new Error('Missing tower definition');

    expect(runtime.evaluatePortal(
      tower.portal.id,
      actorAt(tower.portal.position),
    )).toMatchObject({
      eligible: false,
      reason: 'locked',
      interiorId: 'syndicate-tower',
    });
    expect(runtime.definitions).toHaveLength(5);
  });
});

describe('InteriorRuntime transitions and recovery', () => {
  it('exposes a loading phase, observes the minimum delay, and enters at the authored spawn', async () => {
    const loading = deferred();
    const waits: number[] = [];
    const requests: InteriorLoadRequest[] = [];
    const runtime = new InteriorRuntime({
      loadScene: async (request) => {
        requests.push(request);
        await loading.promise;
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    const pending = runtime.enter('moreno-garage-entry', garageActor());
    expect(runtime.snapshot()).toMatchObject({
      phase: 'loading-enter',
      currentInteriorId: null,
      activePortalId: 'moreno-garage-entry',
    });
    expect(runtime.evaluatePortal('moreno-garage-entry', garageActor()).reason).toBe('busy');
    loading.resolve();

    const result = await pending;
    expect(waits).toEqual([DEFAULT_INTERIOR_TRANSITION_MILLISECONDS]);
    expect(requests.map((request) => request.direction)).toEqual(['enter']);
    expect(result).toEqual({
      success: true,
      phase: 'interior',
      interiorId: 'moreno-garage',
      transform: AUTHORED_INTERIORS[0]?.scene.entrySpawn,
      recovered: false,
    });
    expect(runtime.phase).toBe('interior');
  });

  it('preserves the supplied safe exterior transform through enter and exit', async () => {
    const requests: InteriorLoadRequest[] = [];
    const runtime = immediateRuntime({
      loadScene: async (request) => {
        requests.push(request);
      },
    });
    const safeExteriorTransform: InteriorTransform = {
      position: { x: -249.25, y: 0.2, z: 246.75 },
      heading: 2.45,
    };
    const enterResult = await runtime.enter(
      'moreno-garage-entry',
      garageActor({ safeExteriorTransform }),
    );
    expect(enterResult.success).toBe(true);
    expect(runtime.snapshot().exteriorReturnTransform).toEqual(safeExteriorTransform);

    const scene = runtime.currentDefinition?.scene;
    if (!scene) throw new Error('Expected active scene');
    expect(runtime.evaluateExit(actorAt({ x: 5, y: 0, z: 0 })).reason).toBe('too-far');
    const exitResult = await runtime.exit(actorAt(scene.exitPosition));

    expect(exitResult).toEqual({
      success: true,
      phase: 'exterior',
      interiorId: null,
      transform: safeExteriorTransform,
      recovered: false,
    });
    expect(requests.map((request) => request.direction)).toEqual(['enter', 'exit']);
    expect(runtime.snapshot()).toEqual({
      schemaVersion: INTERIOR_RUNTIME_SNAPSHOT_VERSION,
      phase: 'exterior',
      currentInteriorId: null,
      activePortalId: null,
      exteriorReturnTransform: null,
      lastError: null,
    });
  });

  it('falls back to the authored safe transform when none is supplied', async () => {
    const runtime = immediateRuntime();
    const garage = runtime.definitionForPortal('moreno-garage-entry');
    if (!garage) throw new Error('Missing garage definition');

    await enterGarage(runtime);
    const exitResult = await runtime.exit(actorAt(garage.scene.exitPosition));
    expect(exitResult.success).toBe(true);
    if (exitResult.success) {
      expect(exitResult.transform).toEqual(garage.portal.safeExteriorTransform);
    }
  });

  it('recovers outside after a failed enter and permits a clean retry', async () => {
    let fail = true;
    const runtime = immediateRuntime({
      loadScene: async ({ direction }) => {
        if (direction === 'enter' && fail) throw new Error('garage bundle unavailable');
      },
    });
    const safeExteriorTransform: InteriorTransform = {
      position: { x: -249, y: 0, z: 247 },
      heading: 1.5,
    };

    const failed = await runtime.enter(
      'moreno-garage-entry',
      garageActor({ safeExteriorTransform }),
    );
    expect(failed).toMatchObject({
      success: false,
      phase: 'exterior',
      reason: 'load-failed',
      error: 'garage bundle unavailable',
      recoveryTransform: safeExteriorTransform,
      recovered: true,
    });
    expect(runtime.phase).toBe('exterior');

    fail = false;
    expect((await runtime.enter('moreno-garage-entry', garageActor())).success).toBe(true);
  });

  it('recovers outside after a failed unload instead of trapping the player', async () => {
    const runtime = immediateRuntime({
      loadScene: async ({ direction }) => {
        if (direction === 'exit') throw new Error('scene disposal failed');
      },
    });
    await enterGarage(runtime);
    const scene = runtime.currentDefinition?.scene;
    if (!scene) throw new Error('Expected active scene');

    const result = await runtime.exit(actorAt(scene.exitPosition));
    expect(result).toMatchObject({
      success: false,
      phase: 'exterior',
      reason: 'load-failed',
      error: 'scene disposal failed',
      recovered: true,
    });
    expect(runtime.snapshot()).toMatchObject({
      phase: 'exterior',
      currentInteriorId: null,
      activePortalId: null,
      lastError: 'scene disposal failed',
    });
  });

  it('rejects concurrent transitions without disturbing the active load', async () => {
    const loading = deferred();
    const runtime = immediateRuntime({
      loadScene: async () => loading.promise,
    });

    const first = runtime.enter('moreno-garage-entry', garageActor());
    const second = await runtime.enter('moreno-garage-entry', garageActor());
    expect(second).toMatchObject({ success: false, reason: 'busy' });
    expect(runtime.phase).toBe('loading-enter');
    loading.resolve();
    expect((await first).success).toBe(true);
  });
});

describe('InteriorRuntime snapshot validation and restoration', () => {
  it('round-trips a stable interior with its safe exterior return', async () => {
    const source = immediateRuntime();
    const safeExteriorTransform: InteriorTransform = {
      position: { x: -247.8, y: 0, z: 246.3 },
      heading: -2.1,
    };
    await source.enter(
      'moreno-garage-entry',
      garageActor({ safeExteriorTransform }),
    );
    const snapshot = source.snapshot();

    const restored = immediateRuntime();
    expect(restored.restore(snapshot)).toEqual({
      success: true,
      recovered: false,
      recoveryTransform: null,
    });
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.currentDefinition?.id).toBe('moreno-garage');
  });

  it.each([
    ['version', { schemaVersion: 99 }],
    ['phase', { phase: 'teleporting' }],
    ['unknown portal', { activePortalId: 'missing' }],
    ['mismatched scene', { currentInteriorId: 'juno-grid' }],
    ['non-finite return', {
      exteriorReturnTransform: {
        position: { x: Number.NaN, y: 0, z: 0 },
        heading: 0,
      },
    }],
  ])('rejects an invalid %s snapshot without mutating live state', async (_label, patch) => {
    const runtime = immediateRuntime();
    await enterGarage(runtime);
    const before = runtime.snapshot();
    const invalid = { ...before, ...patch };

    expect(runtime.restore(invalid)).toMatchObject({ success: false });
    expect(runtime.snapshot()).toEqual(before);
  });

  it('normalizes a persisted loading transition to the safe exterior', async () => {
    const loading = deferred();
    const runtime = immediateRuntime({
      loadScene: async () => loading.promise,
    });
    const safeExteriorTransform: InteriorTransform = {
      position: { x: -249, y: 0, z: 246 },
      heading: Math.PI,
    };
    const pending = runtime.enter(
      'moreno-garage-entry',
      garageActor({ safeExteriorTransform }),
    );
    const transientSnapshot: InteriorRuntimeSnapshotV1 = runtime.snapshot();

    expect(runtime.restore(transientSnapshot)).toEqual({
      success: true,
      recovered: true,
      recoveryTransform: safeExteriorTransform,
    });
    expect(runtime.phase).toBe('exterior');

    loading.resolve();
    expect(await pending).toMatchObject({
      success: false,
      reason: 'interrupted',
      recovered: true,
    });
    expect(runtime.phase).toBe('exterior');
  });

  it('validates constructor timing and definition identity', () => {
    expect(() => new InteriorRuntime({
      minimumTransitionMilliseconds: -1,
    })).toThrow(/minimumTransitionMilliseconds/);
    expect(() => new InteriorRuntime({ definitions: [] })).toThrow(/at least one/);

    const garage = AUTHORED_INTERIORS[0];
    if (!garage) throw new Error('Missing garage definition');
    const duplicate: readonly InteriorDefinition[] = [garage, garage];
    expect(() => immediateRuntime({ definitions: duplicate })).toThrow(/Duplicate/);
  });
});
