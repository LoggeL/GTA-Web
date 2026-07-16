import { describe, expect, it, vi } from 'vitest';

import { DIALOGUE } from '../../src/data/missions';
import { DialogueRuntime } from '../../src/runtime/DialogueRuntime';

describe('DialogueRuntime', () => {
  it('sequences authored mission dialogue and advances to completion', () => {
    const runtime = new DialogueRuntime();
    const line = vi.fn();
    const completed = vi.fn();
    runtime.events.on('dialogue:line', line);
    runtime.events.on('dialogue:completed', completed);

    const started = runtime.startMission('past-due');
    expect(started.lineCount).toBe(4);
    expect(started.current?.key).toBe('past-due.intro');
    expect(runtime.advance()?.key).toBe('past-due.chase');
    expect(runtime.advance()?.key).toBe('past-due.recovery');
    expect(runtime.advance()?.key).toBe('past-due.complete');
    expect(runtime.advance()).toBeNull();
    expect(runtime.status).toBe('complete');
    expect(line).toHaveBeenCalledTimes(4);
    expect(completed).toHaveBeenCalledWith({ skipped: false });
  });

  it('skips safely and reports remaining lines', () => {
    const runtime = new DialogueRuntime();
    const skipped = vi.fn();
    runtime.events.on('dialogue:skipped', skipped);
    runtime.startMission('past-due');
    runtime.advance();
    runtime.skip();

    expect(runtime.currentLine).toBeNull();
    expect(runtime.status).toBe('complete');
    expect(skipped).toHaveBeenCalledWith({ remainingLines: 3 });
    expect(() => runtime.skip()).not.toThrow();
  });

  it('preserves valid order while safely omitting missing or mismatched content', () => {
    const runtime = new DialogueRuntime();
    const missing = vi.fn();
    runtime.events.on('dialogue:missing', missing);
    const result = runtime.start([
      'past-due.intro',
      'not-authored',
      'past-due.complete',
    ]);

    expect(result.lineCount).toBe(2);
    expect(result.missingKeys).toEqual(['not-authored']);
    expect(runtime.currentLine?.key).toBe('past-due.intro');
    expect(runtime.advance()?.key).toBe('past-due.complete');
    expect(missing).toHaveBeenCalledWith({ key: 'not-authored' });

    const empty = runtime.start(['still-missing']);
    expect(empty.current).toBeNull();
    expect(runtime.status).toBe('complete');
  });

  it('round-trips snapshots and rejects invalid snapshots without mutation', () => {
    const first = new DialogueRuntime();
    first.startMission('past-due');
    first.advance();
    const snapshot = JSON.parse(JSON.stringify(first.snapshot())) as unknown;
    const second = new DialogueRuntime();

    expect(second.restore(snapshot).success).toBe(true);
    expect(second.currentLine?.key).toBe('past-due.chase');
    const before = second.snapshot();
    expect(second.restore({ snapshotVersion: 2 }).success).toBe(false);
    expect(second.snapshot()).toEqual(before);
  });

  it('degrades restored sequences when content was removed', () => {
    const source = new DialogueRuntime();
    source.start(['past-due.intro', 'past-due.chase']);
    const reducedEntries = DIALOGUE.filter((entry) => entry.key !== 'past-due.intro');
    const restored = new DialogueRuntime({ entries: reducedEntries });

    expect(restored.restore(source.snapshot()).success).toBe(true);
    expect(restored.currentLine?.key).toBe('past-due.chase');
    expect(restored.missingKeys).toContain('past-due.intro');
  });

  it('keeps the same current line when an earlier saved line was removed', () => {
    const source = new DialogueRuntime();
    source.start(['past-due.intro', 'past-due.chase', 'past-due.recovery']);
    source.advance();
    expect(source.currentLine?.key).toBe('past-due.chase');
    const reducedEntries = DIALOGUE.filter((entry) => entry.key !== 'past-due.intro');
    const restored = new DialogueRuntime({ entries: reducedEntries });

    expect(restored.restore(source.snapshot()).success).toBe(true);
    expect(restored.currentLine?.key).toBe('past-due.chase');
  });
});
