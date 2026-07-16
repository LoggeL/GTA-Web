import { createWorldInputState } from '../game';
import type { WorldInputState } from '../game';
import type { InputFrame } from './types';

/** Maps one normalized frame to the existing WorldView input contract. */
export function toWorldInputState(frame: InputFrame): WorldInputState {
  const input = createWorldInputState();
  input.cameraYawDelta = frame.pointerDelta.yaw;
  input.cameraPitchDelta = frame.pointerDelta.pitch;

  if (frame.mode === 'on-foot') {
    input.moveRight = frame.axes.moveRight.value;
    input.moveForward = frame.axes.moveForward.value;
    input.sprint = frame.commands.sprint.pressed;
    input.jump = frame.commands.jump.pressed;
    input.crouch = frame.commands.crouch.pressed;
    input.aim = frame.commands.aim.pressed;
    input.fire = frame.commands.fireOrLightAttack.pressed;
    input.melee = frame.commands.meleeContext.justPressed;
    input.heavyAttackHeld = frame.commands.meleeContext.pressed;
    input.heavyAttackReleased = frame.commands.meleeContext.justReleased;
    input.reload = frame.commands.reload.justPressed;
    input.weaponCycle = frame.commands.weaponRadial.justPressed;
    input.dodge = frame.commands.jump.justPressed && frame.commands.aim.pressed;
    input.shoulderSwap = frame.commands.shoulderSwap.justPressed;
    input.interact = frame.commands.interact.justPressed;
    return input;
  }

  input.moveRight = frame.axes.steer.value;
  input.moveForward = frame.axes.throttle.value;
  input.aim = frame.commands.vehicleAim.pressed;
  input.handbrake = frame.commands.handbrake.pressed;
  input.vehiclePrimaryAction = frame.commands.vehiclePrimaryAction.pressed;
  input.vehicleCameraToggle = frame.commands.cameraToggle.justPressed;
  input.vehicleReset = frame.commands.vehicleReset.justPressed;
  input.interact = frame.commands.enterExit.justPressed;
  return input;
}
