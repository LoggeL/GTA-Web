export type Unsubscribe = () => void;
export type EventListener<Payload> = (payload: Payload) => void;

/** Synchronous, typed event channel used to keep simulation systems decoupled. */
export class EventBus<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<EventListener<unknown>>>();

  public on<Type extends keyof Events>(
    type: Type,
    listener: EventListener<Events[Type]>,
  ): Unsubscribe {
    const listeners = this.listeners.get(type) ?? new Set<EventListener<unknown>>();
    const storedListener = listener as unknown as EventListener<unknown>;
    listeners.add(storedListener);
    this.listeners.set(type, listeners);

    return () => {
      this.remove(type, storedListener);
    };
  }

  public once<Type extends keyof Events>(
    type: Type,
    listener: EventListener<Events[Type]>,
  ): Unsubscribe {
    let unsubscribe: Unsubscribe = () => undefined;
    unsubscribe = this.on(type, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  public emit<Type extends keyof Events>(type: Type, payload: Events[Type]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }

    // Snapshot iteration makes subscription changes during dispatch predictable.
    for (const listener of [...listeners]) {
      listener(payload);
    }
  }

  public clear<Type extends keyof Events>(type?: Type): void {
    if (type === undefined) {
      this.listeners.clear();
      return;
    }
    this.listeners.delete(type);
  }

  public listenerCount<Type extends keyof Events>(type: Type): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  private remove(type: keyof Events, listener: EventListener<unknown>): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      this.listeners.delete(type);
    }
  }
}

export type WantedLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type MissionLifecycle = 'started' | 'checkpoint' | 'completed' | 'failed' | 'abandoned';
export type ChunkLifecycle = 'requested' | 'ready' | 'activated' | 'deactivated' | 'failed';
export type VehicleLifecycle = 'spawned' | 'entered' | 'exited' | 'damaged' | 'disabled' | 'despawned';
export type SaveLifecycle = 'started' | 'completed' | 'failed' | 'recovered';

/** Stable cross-system event surface. Payloads contain ids and data, never render objects. */
export interface GameEventMap {
  'damage:applied': {
    targetId: string;
    sourceId: string | null;
    amount: number;
    remainingHealth: number;
    kind: 'melee' | 'ballistic' | 'collision' | 'environment';
  };
  'crime:reported': {
    crimeId: string;
    severity: number;
    witnessId: string;
    districtId: string;
  };
  'wanted:changed': {
    previous: WantedLevel;
    current: WantedLevel;
    phase: 'clear' | 'investigating' | 'pursuit' | 'search';
  };
  'inventory:transaction': {
    itemId: string;
    quantity: number;
    source: string;
    destination: string;
    reason: 'move' | 'loot' | 'purchase' | 'sale' | 'craft' | 'consume' | 'loss';
  };
  'objective:progress': {
    missionId: string;
    objectiveId: string;
    current: number;
    target: number;
  };
  'mission:lifecycle': {
    missionId: string;
    state: MissionLifecycle;
    checkpointId: string | null;
  };
  'chunk:lifecycle': {
    chunkId: string;
    state: ChunkLifecycle;
    attempt: number;
    error: string | null;
  };
  'vehicle:state': {
    vehicleId: string;
    state: VehicleLifecycle;
    health: number;
  };
  'progression:xp': {
    amount: number;
    totalXp: number;
    level: number;
  };
  'progression:reputation': {
    contactId: string;
    amount: number;
    total: number;
  };
  'save:lifecycle': {
    slotId: 1 | 2 | 3;
    state: SaveLifecycle;
    reason: 'manual' | 'autosave' | 'checkpoint' | 'import' | 'recovery';
    error: string | null;
  };
  'audio:radio': {
    stationId: string | null;
    state: 'selected' | 'playing' | 'paused' | 'stopped';
  };
  'ui:notification': {
    id: string;
    tone: 'info' | 'success' | 'warning' | 'danger';
    message: string;
    durationMs: number;
  };
}

export type GameEventBus = EventBus<GameEventMap>;

export function createGameEventBus(): GameEventBus {
  return new EventBus<GameEventMap>();
}
