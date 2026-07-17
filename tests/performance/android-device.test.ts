import { describe, expect, it } from 'vitest';

import {
  detectEmulatorSignals,
  parseConnectedDevices,
  selectListedDevice,
  type EmulatorIdentityProperties,
  type ListedAndroidDevice,
} from './android-device';

const physicalDevice: ListedAndroidDevice = {
  serial: 'R58M123456A',
  state: 'device',
  details: 'product:a54xeea model:SM-A546B device:a54x',
};

const physicalProperties: EmulatorIdentityProperties = {
  fingerprint: 'samsung/a54xeea/a54x:14/UP1A/release-keys',
  product: 'a54xeea',
  device: 'a54x',
  model: 'SM-A546B',
  hardware: 's5e8835',
  kernelQemu: '0',
  bootQemu: '0',
  virtualDevice: '',
};

describe('Android adb device evidence', () => {
  it('parses adb rows without treating state or details as part of the serial', () => {
    expect(parseConnectedDevices([
      'List of devices attached',
      'R58M123456A device product:a54xeea model:SM-A546B device:a54x transport_id:2',
      'emulator-5554 offline transport_id:4',
      '',
    ].join('\n'))).toEqual([
      {
        ...physicalDevice,
        details: `${physicalDevice.details} transport_id:2`,
      },
      {
        serial: 'emulator-5554',
        state: 'offline',
        details: 'transport_id:4',
      },
    ]);
  });

  it('requires explicit selection when several devices exist and rejects unavailable states', () => {
    const emulator = {
      serial: 'emulator-5554',
      state: 'device',
      details: 'model:sdk_gphone64_arm64',
    };
    expect(() => selectListedDevice([physicalDevice, emulator])).toThrow(/exactly one/u);
    expect(selectListedDevice([physicalDevice, emulator], physicalDevice.serial))
      .toEqual(physicalDevice);
    expect(() => selectListedDevice([
      { ...physicalDevice, state: 'unauthorized' },
    ])).toThrow(/unauthorized/u);
    expect(() => selectListedDevice([physicalDevice], 'missing')).toThrow(/does not name/u);
  });

  it('flags independent emulator signals and leaves a physical identity clean', () => {
    expect(detectEmulatorSignals({
      serial: 'emulator-5554',
      state: 'device',
      details: 'product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a',
    }, {
      fingerprint: 'google/sdk_gphone64_arm64/emu64a:userdebug/dev-keys',
      product: 'sdk_gphone64_arm64',
      device: 'emu64a',
      model: 'sdk_gphone64_arm64',
      hardware: 'ranchu',
      kernelQemu: '1',
      bootQemu: '1',
      virtualDevice: 'true',
    })).toEqual(expect.arrayContaining([
      'serial',
      'ro.kernel.qemu',
      'ro.boot.qemu',
      'ro.hardware.virtual_device',
      'sdk_gphone',
      'ranchu',
    ]));
    expect(detectEmulatorSignals(physicalDevice, physicalProperties)).toEqual([]);
  });
});
