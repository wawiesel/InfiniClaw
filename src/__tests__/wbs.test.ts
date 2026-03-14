import { describe, it, expect, beforeEach } from 'vitest';
import {
  type WbsFile,
  itemsForBot,
  nextReadyItem,
  assignItem,
  reabsorbItems,
  completeItem,
  autoAssign,
  wbsToTodos,
} from '../wbs.js';

function makeWbs(): WbsFile {
  return {
    items: [
      { id: 'a', title: 'Task A', source: 'issue#1', depends_on: [], assigned_to: null, status: 'ready', priority: 1 },
      { id: 'b', title: 'Task B', source: 'issue#2', depends_on: ['a'], assigned_to: null, status: 'backlog', priority: 2 },
      { id: 'c', title: 'Task C', source: 'issue#3', depends_on: [], assigned_to: null, status: 'ready', priority: 3 },
    ],
  };
}

describe('itemsForBot', () => {
  it('returns items assigned to a bot', () => {
    const wbs = makeWbs();
    assignItem(wbs, 'a', 'cid');
    expect(itemsForBot(wbs, 'cid')).toHaveLength(1);
    expect(itemsForBot(wbs, 'cid')[0].id).toBe('a');
  });

  it('excludes done items', () => {
    const wbs = makeWbs();
    assignItem(wbs, 'a', 'cid');
    completeItem(wbs, 'a');
    expect(itemsForBot(wbs, 'cid')).toHaveLength(0);
  });
});

describe('nextReadyItem', () => {
  it('returns highest-priority unassigned ready item', () => {
    const wbs = makeWbs();
    const item = nextReadyItem(wbs);
    expect(item?.id).toBe('a'); // priority 1 wins over 3
  });

  it('skips backlog items (unmet dependencies)', () => {
    const wbs = makeWbs();
    wbs.items[0].status = 'in_progress'; // 'a' taken
    wbs.items[0].assigned_to = 'parker';
    const item = nextReadyItem(wbs);
    expect(item?.id).toBe('c'); // 'b' still in backlog, 'c' is ready
  });

  it('returns undefined when nothing ready', () => {
    const wbs: WbsFile = { items: [] };
    expect(nextReadyItem(wbs)).toBeUndefined();
  });
});

describe('assignItem', () => {
  it('assigns and marks in_progress', () => {
    const wbs = makeWbs();
    const ok = assignItem(wbs, 'a', 'cid');
    expect(ok).toBe(true);
    const item = wbs.items.find((i) => i.id === 'a')!;
    expect(item.assigned_to).toBe('cid');
    expect(item.status).toBe('in_progress');
  });

  it('returns false for done items', () => {
    const wbs = makeWbs();
    completeItem(wbs, 'a');
    expect(assignItem(wbs, 'a', 'cid')).toBe(false);
  });

  it('returns false for unknown id', () => {
    const wbs = makeWbs();
    expect(assignItem(wbs, 'zzz', 'cid')).toBe(false);
  });
});

describe('reabsorbItems', () => {
  it('resets assigned items to ready/unassigned', () => {
    const wbs = makeWbs();
    assignItem(wbs, 'a', 'cid');
    assignItem(wbs, 'c', 'cid');
    const count = reabsorbItems(wbs, 'cid');
    expect(count).toBe(2);
    for (const item of wbs.items.filter((i) => i.id !== 'b')) {
      expect(item.assigned_to).toBeNull();
      expect(item.status).toBe('ready');
    }
  });

  it('does not touch done items', () => {
    const wbs = makeWbs();
    assignItem(wbs, 'a', 'cid');
    completeItem(wbs, 'a');
    const count = reabsorbItems(wbs, 'cid');
    expect(count).toBe(0);
    expect(wbs.items.find((i) => i.id === 'a')?.status).toBe('done');
  });
});

describe('completeItem', () => {
  it('marks item done and unblocks dependents', () => {
    const wbs = makeWbs();
    assignItem(wbs, 'a', 'cid');
    const unblocked = completeItem(wbs, 'a');
    expect(unblocked).toContain('b');
    expect(wbs.items.find((i) => i.id === 'b')?.status).toBe('ready');
  });

  it('returns empty array for unknown id', () => {
    const wbs = makeWbs();
    expect(completeItem(wbs, 'zzz')).toEqual([]);
  });

  it('does not unblock items with remaining dependencies', () => {
    const wbs: WbsFile = {
      items: [
        { id: 'x', title: 'X', depends_on: [], assigned_to: 'cid', status: 'in_progress', priority: 1 },
        { id: 'y', title: 'Y', depends_on: [], assigned_to: 'cid', status: 'in_progress', priority: 2 },
        { id: 'z', title: 'Z', depends_on: ['x', 'y'], assigned_to: null, status: 'backlog', priority: 3 },
      ],
    };
    completeItem(wbs, 'x'); // y still in progress
    expect(wbs.items.find((i) => i.id === 'z')?.status).toBe('backlog');
    completeItem(wbs, 'y'); // now z unblocks
    expect(wbs.items.find((i) => i.id === 'z')?.status).toBe('ready');
  });
});

describe('autoAssign', () => {
  it('assigns highest-priority ready item to bot', () => {
    const wbs = makeWbs();
    const item = autoAssign(wbs, 'cid');
    expect(item?.id).toBe('a');
    expect(wbs.items.find((i) => i.id === 'a')?.assigned_to).toBe('cid');
  });

  it('returns undefined if nothing ready', () => {
    const wbs: WbsFile = { items: [] };
    expect(autoAssign(wbs, 'cid')).toBeUndefined();
  });
});

describe('wbsToTodos', () => {
  it('converts in_progress item to in_progress todo', () => {
    const items = [
      { id: 'a', title: 'Do thing', depends_on: [], assigned_to: 'cid', status: 'in_progress' as const, priority: 1 },
    ];
    const todos = wbsToTodos(items);
    expect(todos[0].status).toBe('in_progress');
    expect(todos[0].content).toBe('Do thing');
  });

  it('converts ready item to pending todo', () => {
    const items = [
      { id: 'b', title: 'Other thing', depends_on: [], assigned_to: 'cid', status: 'ready' as const, priority: 2 },
    ];
    const todos = wbsToTodos(items);
    expect(todos[0].status).toBe('pending');
  });
});
