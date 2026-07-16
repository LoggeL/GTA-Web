import type { VehicleClassId, VehicleDefinition } from '../data/types';
import { VEHICLES } from '../data/vehicles';

export const DEFAULT_VEHICLE_CLASS_ID: VehicleClassId = 'compact';

/**
 * The driveable profile list intentionally aliases the authored vehicle data so
 * handling, traffic, economy, and display names cannot drift into parallel registries.
 */
export const VEHICLE_DRIVE_PROFILES: readonly VehicleDefinition[] = VEHICLES;

const PROFILE_BY_CLASS = new Map<VehicleClassId, VehicleDefinition>(
  VEHICLE_DRIVE_PROFILES.map((profile) => [profile.id, profile]),
);

export function getVehicleDriveProfile(classId: VehicleClassId): VehicleDefinition | undefined {
  return PROFILE_BY_CLASS.get(classId);
}

export function requireVehicleDriveProfile(classId: VehicleClassId): VehicleDefinition {
  const profile = getVehicleDriveProfile(classId);
  if (profile === undefined) {
    throw new Error(`Unknown vehicle class: ${classId}`);
  }
  return profile;
}

export function vehicleTopSpeedMetersPerSecond(
  profile: Pick<VehicleDefinition, 'topSpeedKph'>,
): number {
  return profile.topSpeedKph / 3.6;
}

export function vehicleReverseSpeedMetersPerSecond(
  profile: Pick<VehicleDefinition, 'arcadeHandling'>,
): number {
  return profile.arcadeHandling.reverseSpeedKph / 3.6;
}
