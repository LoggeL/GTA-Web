import { InputMap, isValidKeyboardCode, isValidMouseCode } from './InputMap';
import type {
  ActionStateMap,
  AxisState,
  BindingDevice,
  ButtonState,
  InputAction,
  InputBinding,
  InputBindingSnapshot,
  InputFrame,
  InputMode,
  OnFootCommand,
  OnFootInputFrame,
  PointerDelta,
  TouchControlAction,
  VehicleCommand,
  VehicleInputFrame,
} from './types';
import { INPUT_ACTIONS } from './types';

export interface InputControllerOptions {
  readonly inputMap?: InputMap;
  readonly mode?: InputMode;
  readonly mouseRadiansPerPixel?: number;
  readonly touchRadiansPerPixel?: number;
  readonly invertY?: boolean;
  readonly analogDeadzone?: number;
}

const TOUCH_ACTION_MAP: Readonly<Record<TouchControlAction, InputAction>> = {
  fire: 'primaryAction',
  aim: 'aim',
  sprint: 'sprint',
  jump: 'jumpHandbrake',
  crouch: 'crouchCamera',
  interact: 'interactEnterExit',
  melee: 'meleeContext',
  reload: 'reloadVehicleReset',
  shoulderSwap: 'shoulderSwap',
  weaponRadial: 'weaponRadial',
  inventory: 'inventory',
  map: 'map',
  pause: 'pause',
};

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function clampAxis(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('Axis value must be finite');
  }
  return Math.max(-1, Math.min(1, value));
}

function createActionStateMap(
  stateFor: (action: InputAction) => ButtonState,
): Record<InputAction, ButtonState> {
  const result = {} as Record<InputAction, ButtonState>;
  for (const action of INPUT_ACTIONS) {
    result[action] = stateFor(action);
  }
  return result;
}

export class InputController {
  readonly #inputMap: InputMap;
  readonly #sourcesByAction = new Map<InputAction, Set<string>>();
  readonly #actionBySource = new Map<string, InputAction>();
  readonly #justPressed = new Set<InputAction>();
  readonly #justReleased = new Set<InputAction>();
  readonly #mouseRadiansPerPixel: number;
  readonly #touchRadiansPerPixel: number;
  readonly #invertY: boolean;
  readonly #analogDeadzone: number;
  #mode: InputMode;
  #touchMoveRight = 0;
  #touchMoveForward = 0;
  #previousHorizontal = 0;
  #previousVertical = 0;
  #pointerYaw = 0;
  #pointerPitch = 0;
  #sequence = 0;

  public constructor(options: InputControllerOptions = {}) {
    this.#inputMap = options.inputMap
      ? new InputMap(options.inputMap.snapshot().bindings)
      : new InputMap();
    this.#mode = options.mode ?? 'on-foot';
    this.#mouseRadiansPerPixel = options.mouseRadiansPerPixel ?? 0.0032;
    this.#touchRadiansPerPixel = options.touchRadiansPerPixel ?? 0.006;
    this.#invertY = options.invertY ?? false;
    this.#analogDeadzone = options.analogDeadzone ?? 0.08;
    assertFiniteNonNegative(this.#mouseRadiansPerPixel, 'mouseRadiansPerPixel');
    assertFiniteNonNegative(this.#touchRadiansPerPixel, 'touchRadiansPerPixel');
    if (
      !Number.isFinite(this.#analogDeadzone) ||
      this.#analogDeadzone < 0 ||
      this.#analogDeadzone >= 1
    ) {
      throw new RangeError('analogDeadzone must be in the range [0, 1)');
    }
    for (const action of INPUT_ACTIONS) {
      this.#sourcesByAction.set(action, new Set<string>());
    }
  }

  public get mode(): InputMode {
    return this.#mode;
  }

  public setMode(mode: InputMode): void {
    if (mode === this.#mode) {
      return;
    }
    this.releaseAll();
    this.#mode = mode;
  }

  public keyDown(code: string, repeat: boolean = false): boolean {
    if (!isValidKeyboardCode(code)) {
      throw new Error(`Invalid keyboard code: ${code}`);
    }
    return this.setBindingState({ device: 'keyboard', code }, true, repeat);
  }

  public keyUp(code: string): boolean {
    if (!isValidKeyboardCode(code)) {
      throw new Error(`Invalid keyboard code: ${code}`);
    }
    return this.setBindingState({ device: 'keyboard', code }, false);
  }

  public mouseButtonDown(button: number): boolean {
    const code = this.#mouseCode(button);
    return this.setBindingState({ device: 'mouse', code }, true);
  }

  public mouseButtonUp(button: number): boolean {
    const code = this.#mouseCode(button);
    return this.setBindingState({ device: 'mouse', code }, false);
  }

  public setBindingState(
    binding: Readonly<InputBinding>,
    pressed: boolean,
    repeat: boolean = false,
  ): boolean {
    const valid = binding.device === 'keyboard'
      ? isValidKeyboardCode(binding.code)
      : isValidMouseCode(binding.code);
    if (!valid) {
      throw new Error(`Invalid ${binding.device} code: ${binding.code}`);
    }
    const sourceId = `${binding.device}:${binding.code}`;
    if (!pressed) {
      const active = this.#actionBySource.has(sourceId);
      this.#setSource(sourceId, undefined, false);
      return active;
    }
    if (repeat && this.#actionBySource.has(sourceId)) {
      return true;
    }
    const action = this.#inputMap.getActionFor(binding.device, binding.code);
    if (action === undefined) {
      return false;
    }
    this.#setSource(sourceId, action, true);
    return true;
  }

  public setTouchAction(action: TouchControlAction, pressed: boolean): void {
    const sourceId = `touch:${action}`;
    this.#setSource(sourceId, TOUCH_ACTION_MAP[action], pressed);
  }

  public setTouchMovement(moveRight: number, moveForward: number): void {
    this.#touchMoveRight = clampAxis(moveRight);
    this.#touchMoveForward = clampAxis(moveForward);
  }

  public injectPointerDelta(
    deltaX: number,
    deltaY: number,
    source: 'mouse' | 'touch' = 'mouse',
  ): void {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      throw new TypeError('Pointer deltas must be finite');
    }
    const sensitivity = source === 'touch'
      ? this.#touchRadiansPerPixel
      : this.#mouseRadiansPerPixel;
    this.#pointerYaw -= deltaX * sensitivity;
    const pitchDirection = this.#invertY ? 1 : -1;
    this.#pointerPitch += deltaY * sensitivity * pitchDirection;
  }

  public getActionState(action: InputAction): ButtonState {
    return {
      pressed: (this.#sourcesByAction.get(action)?.size ?? 0) > 0,
      justPressed: this.#justPressed.has(action),
      justReleased: this.#justReleased.has(action),
    };
  }

  public isPressed(action: InputAction): boolean {
    return (this.#sourcesByAction.get(action)?.size ?? 0) > 0;
  }

  public actionForBinding(device: BindingDevice, code: string): InputAction | undefined {
    return this.#inputMap.getActionFor(device, code);
  }

  public getBindings(action: InputAction): readonly Readonly<InputBinding>[] {
    return this.#inputMap.getBindings(action);
  }

  public remapKeyboard(action: InputAction, code: string): void {
    this.#inputMap.remapKeyboard(action, code);
    this.releaseAll();
  }

  public setKeyboardBindings(action: InputAction, codes: readonly string[]): void {
    this.#inputMap.setKeyboardBindings(action, codes);
    this.releaseAll();
  }

  public bindingSnapshot(): InputBindingSnapshot {
    return this.#inputMap.snapshot();
  }

  public restoreBindings(snapshot: unknown): void {
    this.#inputMap.restore(snapshot);
    this.releaseAll();
  }

  public handleBlur(): void {
    this.releaseAll();
  }

  public handleVisibilityChange(hidden: boolean): void {
    if (hidden) {
      this.releaseAll();
    }
  }

  public releaseAll(): void {
    for (const action of INPUT_ACTIONS) {
      const sources = this.#sourcesByAction.get(action);
      if ((sources?.size ?? 0) > 0) {
        this.#justReleased.add(action);
      }
      sources?.clear();
    }
    this.#actionBySource.clear();
    this.#touchMoveRight = 0;
    this.#touchMoveForward = 0;
    this.#pointerYaw = 0;
    this.#pointerPitch = 0;
  }

  public consumeFrame(): InputFrame {
    const actions = createActionStateMap((action) => this.getActionState(action));
    const horizontal = this.#resolvedAxis(
      this.#touchMoveRight,
      Number(actions.moveRight.pressed) - Number(actions.moveLeft.pressed),
    );
    const vertical = this.#resolvedAxis(
      this.#touchMoveForward,
      Number(actions.moveForward.pressed) - Number(actions.moveBackward.pressed),
    );
    const horizontalState = this.#axisState(horizontal, this.#previousHorizontal);
    const verticalState = this.#axisState(vertical, this.#previousVertical);
    const pointerDelta: PointerDelta = {
      yaw: this.#pointerYaw,
      pitch: this.#pointerPitch,
    };
    this.#sequence += 1;

    const frame = this.#mode === 'on-foot'
      ? this.#onFootFrame(actions, horizontalState, verticalState, pointerDelta)
      : this.#vehicleFrame(actions, horizontalState, verticalState, pointerDelta);

    this.#previousHorizontal = horizontal;
    this.#previousVertical = vertical;
    this.#justPressed.clear();
    this.#justReleased.clear();
    this.#pointerYaw = 0;
    this.#pointerPitch = 0;
    return frame;
  }

  #onFootFrame(
    actions: ActionStateMap,
    moveRight: AxisState,
    moveForward: AxisState,
    pointerDelta: PointerDelta,
  ): OnFootInputFrame {
    const commands: Record<OnFootCommand, ButtonState> = {
      fireOrLightAttack: actions.primaryAction,
      aim: actions.aim,
      sprint: actions.sprint,
      jump: actions.jumpHandbrake,
      crouch: actions.crouchCamera,
      interact: actions.interactEnterExit,
      meleeContext: actions.meleeContext,
      reload: actions.reloadVehicleReset,
      shoulderSwap: actions.shoulderSwap,
      weaponRadial: actions.weaponRadial,
      inventory: actions.inventory,
      map: actions.map,
      pause: actions.pause,
    };
    return {
      sequence: this.#sequence,
      mode: 'on-foot',
      actions,
      axes: { moveRight, moveForward },
      commands,
      pointerDelta,
    };
  }

  #vehicleFrame(
    actions: ActionStateMap,
    steer: AxisState,
    throttle: AxisState,
    pointerDelta: PointerDelta,
  ): VehicleInputFrame {
    const commands: Record<VehicleCommand, ButtonState> = {
      vehiclePrimaryAction: actions.primaryAction,
      vehicleAim: actions.aim,
      handbrake: actions.jumpHandbrake,
      cameraToggle: actions.crouchCamera,
      enterExit: actions.interactEnterExit,
      vehicleReset: actions.reloadVehicleReset,
      weaponRadial: actions.weaponRadial,
      inventory: actions.inventory,
      map: actions.map,
      pause: actions.pause,
    };
    return {
      sequence: this.#sequence,
      mode: 'vehicle',
      actions,
      axes: { steer, throttle },
      commands,
      pointerDelta,
    };
  }

  #setSource(sourceId: string, requestedAction: InputAction | undefined, pressed: boolean): void {
    if (pressed) {
      if (requestedAction === undefined || this.#actionBySource.has(sourceId)) {
        return;
      }
      const sources = this.#sourcesByAction.get(requestedAction);
      if (sources === undefined) {
        return;
      }
      const wasPressed = sources.size > 0;
      sources.add(sourceId);
      this.#actionBySource.set(sourceId, requestedAction);
      if (!wasPressed) {
        this.#justPressed.add(requestedAction);
      }
      return;
    }

    const action = this.#actionBySource.get(sourceId);
    if (action === undefined) {
      return;
    }
    const sources = this.#sourcesByAction.get(action);
    sources?.delete(sourceId);
    this.#actionBySource.delete(sourceId);
    if (sources?.size === 0) {
      this.#justReleased.add(action);
    }
  }

  #resolvedAxis(analogValue: number, digitalValue: number): number {
    const analog = this.#applyDeadzone(analogValue);
    return analog === 0 ? clampAxis(digitalValue) : analog;
  }

  #applyDeadzone(value: number): number {
    const magnitude = Math.abs(value);
    if (magnitude <= this.#analogDeadzone) {
      return 0;
    }
    const normalized = (magnitude - this.#analogDeadzone) / (1 - this.#analogDeadzone);
    return Math.sign(value) * normalized;
  }

  #axisState(value: number, previousValue: number): AxisState {
    const pressed = Math.abs(value) > Number.EPSILON;
    const previouslyPressed = Math.abs(previousValue) > Number.EPSILON;
    return {
      value,
      previousValue,
      pressed,
      justPressed: pressed && !previouslyPressed,
      justReleased: !pressed && previouslyPressed,
    };
  }

  #mouseCode(button: number): string {
    if (!Number.isSafeInteger(button) || button < 0 || button > 4) {
      throw new RangeError('Mouse button must be an integer from 0 to 4');
    }
    return `Mouse${button}`;
  }
}
