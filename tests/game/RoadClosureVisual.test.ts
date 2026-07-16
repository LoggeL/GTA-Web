import { describe, expect, it } from 'vitest';

import { RoadClosureVisual } from '../../src/game/RoadClosureVisual';
import type { RoadClosureState } from '../../src/navigation/types';

const closure = (overrides: Partial<RoadClosureState> = {}): RoadClosureState => ({
  id: 'closure:cell:0:0:cell:1:0',
  fromCellId: 'cell:0:0',
  toCellId: 'cell:1:0',
  reason: 'chunk-load-failed',
  message: 'Road closed while the next city block loads.',
  ...overrides,
});

describe('RoadClosureVisual', () => {
  it('renders one deterministic hazard barrier per unique closure', () => {
    const visual = new RoadClosureVisual();
    const snapshot = visual.setClosures([
      closure(),
      closure(),
      closure({
        id: 'closure:cell:0:0:cell:0:1',
        toCellId: 'cell:0:1',
      }),
    ]);
    expect(snapshot.closureIds).toEqual([
      'closure:cell:0:0:cell:0:1',
      'closure:cell:0:0:cell:1:0',
    ]);
    expect(snapshot.barrierCount).toBe(2);
    expect(visual.collisions).toHaveLength(2);
    expect(visual.root.visible).toBe(true);
    expect(visual.root.children.every((group) => group.children.length === 8)).toBe(true);
  });

  it('clears closures without disposing reusable shared resources', () => {
    const visual = new RoadClosureVisual();
    visual.setClosures([closure()]);
    expect(visual.setClosures([])).toEqual({ closureIds: [], barrierCount: 0 });
    expect(visual.root.visible).toBe(false);
    expect(visual.collisions).toHaveLength(0);
  });

  it('disposes idempotently and rejects later mutation', () => {
    const visual = new RoadClosureVisual();
    visual.setClosures([closure()]);
    visual.dispose();
    visual.dispose();
    expect(visual.disposed).toBe(true);
    expect(visual.root.children).toHaveLength(0);
    expect(() => visual.setClosures([])).toThrow(/disposed/);
  });
});
