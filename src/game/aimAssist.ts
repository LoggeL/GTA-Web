export type AimAssistLevel = 'off' | 'low' | 'medium' | 'high';
export type AimAssistDevice = 'desktop' | 'mobile';

export interface AimVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface AimAssistTarget {
  readonly id: string;
  readonly position: AimVector;
  readonly velocity?: AimVector;
  readonly radiusMeters: number;
  readonly active: boolean;
  readonly hostile: boolean;
  readonly visible: boolean;
}

export interface AimAssistRequest {
  readonly device: AimAssistDevice;
  readonly level: AimAssistLevel;
  readonly origin: AimVector;
  readonly inputDirection: AimVector;
  readonly targets: readonly AimAssistTarget[];
  readonly maximumRangeMeters: number;
  readonly projectileSpeedMetersPerSecond?: number;
  readonly currentTargetId?: string | null;
  /** Desktop free aim is unchanged unless the player explicitly enables soft lock. */
  readonly desktopSoftLockEnabled?: boolean;
  /** Mobile may acquire a target with a one-frame snap when aim is first pressed. */
  readonly allowTargetSnap?: boolean;
}

export interface AimAssistResult {
  readonly targetId: string | null;
  readonly direction: AimVector;
  readonly predictedTargetPosition: AimVector | null;
  readonly correctionRadians: number;
  readonly strength: number;
  readonly snapped: boolean;
  readonly candidateCount: number;
}

interface AimTuning {
  coneRadians: number;
  snapConeRadians: number;
  correctionStrength: number;
}

const DEG = Math.PI / 180;
const TUNING: Readonly<Record<AimAssistDevice, Readonly<Record<Exclude<AimAssistLevel, 'off'>, AimTuning>>>> = Object.freeze({
  desktop: {
    low: { coneRadians: 2.5 * DEG, snapConeRadians: 0, correctionStrength: 0.12 },
    medium: { coneRadians: 4 * DEG, snapConeRadians: 0, correctionStrength: 0.2 },
    high: { coneRadians: 6 * DEG, snapConeRadians: 0, correctionStrength: 0.3 },
  },
  mobile: {
    low: { coneRadians: 9 * DEG, snapConeRadians: 3.5 * DEG, correctionStrength: 0.5 },
    medium: { coneRadians: 15 * DEG, snapConeRadians: 5.5 * DEG, correctionStrength: 0.68 },
    high: { coneRadians: 22 * DEG, snapConeRadians: 8.5 * DEG, correctionStrength: 0.82 },
  },
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertVector(vector: Readonly<AimVector>, label: string): void {
  if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
    throw new RangeError(`${label} must contain finite coordinates`);
  }
}

function normalize(vector: Readonly<AimVector>): AimVector {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length < 0.000001) throw new RangeError('aim direction must not be zero length');
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function subtract(left: Readonly<AimVector>, right: Readonly<AimVector>): AimVector {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function dot(left: Readonly<AimVector>, right: Readonly<AimVector>): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function angleBetween(left: Readonly<AimVector>, right: Readonly<AimVector>): number {
  return Math.acos(clamp(dot(left, right), -1, 1));
}

function mixDirections(from: Readonly<AimVector>, to: Readonly<AimVector>, amount: number): AimVector {
  return normalize({
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    z: from.z + (to.z - from.z) * amount,
  });
}

function predictPosition(
  target: Readonly<AimAssistTarget>,
  origin: Readonly<AimVector>,
  projectileSpeedMetersPerSecond: number | undefined,
): AimVector {
  if (!target.velocity || !projectileSpeedMetersPerSecond || projectileSpeedMetersPerSecond <= 0) {
    return { ...target.position };
  }
  const distance = Math.hypot(
    target.position.x - origin.x,
    target.position.y - origin.y,
    target.position.z - origin.z,
  );
  const leadSeconds = Math.min(0.75, distance / projectileSpeedMetersPerSecond);
  return {
    x: target.position.x + target.velocity.x * leadSeconds,
    y: target.position.y + target.velocity.y * leadSeconds,
    z: target.position.z + target.velocity.z * leadSeconds,
  };
}

export function resolveAimAssist(request: Readonly<AimAssistRequest>): AimAssistResult {
  assertVector(request.origin, 'aim origin');
  assertVector(request.inputDirection, 'input aim direction');
  if (!Number.isFinite(request.maximumRangeMeters) || request.maximumRangeMeters <= 0) {
    throw new RangeError('aim assist range must be finite and positive');
  }
  if (
    request.projectileSpeedMetersPerSecond !== undefined
    && (!Number.isFinite(request.projectileSpeedMetersPerSecond) || request.projectileSpeedMetersPerSecond <= 0)
  ) {
    throw new RangeError('projectile speed must be finite and positive');
  }
  const inputDirection = normalize(request.inputDirection);
  const disabled = request.level === 'off'
    || (request.device === 'desktop' && !request.desktopSoftLockEnabled);
  if (disabled) {
    return {
      targetId: null, direction: inputDirection, predictedTargetPosition: null,
      correctionRadians: 0, strength: 0, snapped: false, candidateCount: 0,
    };
  }

  const tuning = TUNING[request.device][request.level];
  const candidates = request.targets.flatMap((target) => {
    if (!target.active || !target.hostile || !target.visible) return [];
    assertVector(target.position, `aim target ${target.id} position`);
    if (target.velocity) assertVector(target.velocity, `aim target ${target.id} velocity`);
    if (!Number.isFinite(target.radiusMeters) || target.radiusMeters < 0) {
      throw new RangeError(`aim target ${target.id} radius must be finite and non-negative`);
    }
    const predictedPosition = predictPosition(target, request.origin, request.projectileSpeedMetersPerSecond);
    const offset = subtract(predictedPosition, request.origin);
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    if (distance <= 0.000001 || distance > request.maximumRangeMeters) return [];
    const targetDirection = normalize(offset);
    const centerAngle = angleBetween(inputDirection, targetDirection);
    const angularRadius = Math.atan2(target.radiusMeters, distance);
    const effectiveAngle = Math.max(0, centerAngle - angularRadius);
    if (effectiveAngle > tuning.coneRadians) return [];
    const angularScore = 1 - effectiveAngle / tuning.coneRadians;
    const distanceScore = 1 - distance / request.maximumRangeMeters;
    const continuityBonus = target.id === request.currentTargetId ? 0.18 : 0;
    return [{
      target,
      predictedPosition,
      targetDirection,
      centerAngle,
      score: angularScore * 0.76 + distanceScore * 0.24 + continuityBonus,
    }];
  }).sort((left, right) => right.score - left.score || left.target.id.localeCompare(right.target.id));

  const selected = candidates[0];
  if (!selected) {
    return {
      targetId: null, direction: inputDirection, predictedTargetPosition: null,
      correctionRadians: 0, strength: 0, snapped: false, candidateCount: 0,
    };
  }
  const snapped = request.device === 'mobile'
    && Boolean(request.allowTargetSnap)
    && selected.centerAngle <= tuning.snapConeRadians;
  const strength = snapped ? 1 : tuning.correctionStrength;
  const direction = mixDirections(inputDirection, selected.targetDirection, strength);
  return {
    targetId: selected.target.id,
    direction,
    predictedTargetPosition: selected.predictedPosition,
    correctionRadians: angleBetween(inputDirection, direction),
    strength,
    snapped,
    candidateCount: candidates.length,
  };
}
