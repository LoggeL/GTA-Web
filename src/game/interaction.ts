import type { CollisionRect } from './city';
import { cameraSafeFraction } from './collision';
import type { Vec3Data, WorldInteractionKind, WorldInteractionSnapshot } from './types';

export interface InteractionCandidate {
  id: string;
  kind: WorldInteractionKind;
  position: Vec3Data;
  prompt: string;
  radius?: number;
  enabled?: boolean;
}

export interface InteractionQuery {
  origin: Readonly<Vec3Data>;
  heading: number;
  maximumDistance: number;
  candidates: readonly InteractionCandidate[];
  collisions?: readonly CollisionRect[];
}

interface RankedInteraction extends WorldInteractionSnapshot {
  score: number;
}

export function findNearestInteractionTarget(query: Readonly<InteractionQuery>): WorldInteractionSnapshot | null {
  const forwardX = -Math.sin(query.heading);
  const forwardZ = -Math.cos(query.heading);
  const collisions = query.collisions ?? [];
  const ranked: RankedInteraction[] = [];

  for (const candidate of query.candidates) {
    if (candidate.enabled === false) {
      continue;
    }
    const deltaX = candidate.position.x - query.origin.x;
    const deltaZ = candidate.position.z - query.origin.z;
    const centerDistance = Math.hypot(deltaX, deltaZ);
    const edgeDistance = Math.max(0, centerDistance - (candidate.radius ?? 0));
    if (edgeDistance > query.maximumDistance) {
      continue;
    }
    const facing = centerDistance < 0.001
      ? 1
      : (deltaX * forwardX + deltaZ * forwardZ) / centerDistance;
    if (edgeDistance > 1.5 && facing < -0.55) {
      continue;
    }

    const eye = { x: query.origin.x, y: query.origin.y + 1.2, z: query.origin.z };
    const target = { x: candidate.position.x, y: candidate.position.y + 1, z: candidate.position.z };
    if (cameraSafeFraction(eye, target, collisions, 0.15) < 0.965) {
      continue;
    }
    ranked.push({
      id: candidate.id,
      kind: candidate.kind,
      prompt: candidate.prompt,
      distanceMeters: edgeDistance,
      position: { ...candidate.position },
      score: edgeDistance + (1 - facing) * 0.18,
    });
  }

  ranked.sort((first, second) => first.score - second.score || first.id.localeCompare(second.id));
  const nearest = ranked[0];
  if (!nearest) {
    return null;
  }
  return {
    id: nearest.id,
    kind: nearest.kind,
    prompt: nearest.prompt,
    distanceMeters: nearest.distanceMeters,
    position: { ...nearest.position },
  };
}
