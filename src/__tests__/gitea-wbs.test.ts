/**
 * Tests for the WBS → Gitea issue/PR pipeline (gitea-wbs.ts).
 *
 * All Gitea API calls are intercepted via a vi.stubGlobal mock on fetch.
 * The secrets file system is stubbed so no real files are read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Stub ship-config before importing gitea-wbs ───────────────────────────────
vi.mock('../ship-config.js', () => ({
  loadShipConfig: () => ({ secretsPath: '/fake/secrets', bots: [], s3: undefined }),
}));

// ── Stub fs so gitea.json reads return controlled data ────────────────────────
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.endsWith('gitea.json')) {
          return JSON.stringify({ url: 'https://gitea.example.com', api_token: 'test-token' });
        }
        throw new Error(`unexpected readFileSync: ${p}`);
      }),
    },
  };
});

import {
  giteaCreateIssueForWbs,
  giteaCloseIssue,
  giteaCreatePrForBranch,
  loadGiteaAdminConfig,
} from '../gitea-wbs.js';
import type { WbsItem } from '../wbs.js';

function makeItem(overrides: Partial<WbsItem> = {}): WbsItem {
  return {
    id: '3.6',
    title: 'WBS pipeline',
    depends_on: [],
    assigned_to: 'murdock',
    status: 'in_progress',
    priority: 1,
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── loadGiteaAdminConfig ──────────────────────────────────────────────────────

describe('loadGiteaAdminConfig', () => {
  it('returns config when gitea.json is valid', () => {
    const cfg = loadGiteaAdminConfig();
    expect(cfg).toEqual({ url: 'https://gitea.example.com', token: 'test-token' });
  });
});

// ── giteaCreateIssueForWbs ────────────────────────────────────────────────────

describe('giteaCreateIssueForWbs', () => {
  it('calls Gitea API and returns issue number on success', async () => {
    mockFetch(201, { number: 42 });
    const item = makeItem();
    const num = await giteaCreateIssueForWbs(item, 'engineering');
    expect(num).toBe(42);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/repos/wawiesel/infiniclaw/issues');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.title).toBe('WBS 3.6: WBS pipeline');
    expect(body.body).toContain('3.6');
    expect(body.body).toContain('engineering');
    expect(body.body).toContain('murdock');
  });

  it('returns null when fetch returns non-ok status', async () => {
    mockFetch(422, { message: 'validation failed' });
    const num = await giteaCreateIssueForWbs(makeItem(), 'engineering');
    expect(num).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const num = await giteaCreateIssueForWbs(makeItem(), 'engineering');
    expect(num).toBeNull();
  });

  it('includes source in body when item has a source', async () => {
    mockFetch(201, { number: 7 });
    const item = makeItem({ source: 'issue#42' });
    await giteaCreateIssueForWbs(item, 'engineering');
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.body).toContain('issue#42');
  });
});

// ── giteaCloseIssue ───────────────────────────────────────────────────────────

describe('giteaCloseIssue', () => {
  it('PATCHes the issue with state: closed', async () => {
    mockFetch(200, { number: 42, state: 'closed' });
    await giteaCloseIssue(42);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/repos/wawiesel/infiniclaw/issues/42');
    expect(opts.method).toBe('PATCH');
    const body = JSON.parse(opts.body as string);
    expect(body.state).toBe('closed');
  });

  it('does not throw when fetch returns non-ok', async () => {
    mockFetch(404, { message: 'not found' });
    await expect(giteaCloseIssue(999)).resolves.toBeUndefined();
  });

  it('does not throw when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    await expect(giteaCloseIssue(42)).resolves.toBeUndefined();
  });
});

// ── giteaCreatePrForBranch ────────────────────────────────────────────────────

describe('giteaCreatePrForBranch', () => {
  it('creates PR with Closes link when issueNumber is provided', async () => {
    mockFetch(201, { number: 55, html_url: 'https://gitea.example.com/wawiesel/infiniclaw/pulls/55' });
    await giteaCreatePrForBranch({ branch: 'wbs/3.6/pipeline', wbsId: '3.6', itemTitle: 'WBS pipeline', issueNumber: 42 });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/repos/wawiesel/infiniclaw/pulls');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.title).toBe('WBS 3.6: WBS pipeline');
    expect(body.head).toBe('wbs/3.6/pipeline');
    expect(body.base).toBe('main');
    expect(body.body).toContain('Closes #42');
  });

  it('creates PR without Closes when issueNumber is null', async () => {
    mockFetch(201, { number: 56, html_url: 'https://gitea.example.com/wawiesel/infiniclaw/pulls/56' });
    await giteaCreatePrForBranch({ branch: 'feature/x', wbsId: '1.1', itemTitle: 'Thing', issueNumber: null });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.body).not.toContain('Closes');
    expect(body.body).toContain('1.1');
  });

  it('skips main branch — no fetch call', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await giteaCreatePrForBranch({ branch: 'main', wbsId: '1.1', itemTitle: 'Thing', issueNumber: null });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('skips master branch — no fetch call', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await giteaCreatePrForBranch({ branch: 'master', wbsId: '1.1', itemTitle: 'Thing', issueNumber: null });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not throw when fetch returns non-ok', async () => {
    mockFetch(422, { message: 'PR already exists' });
    await expect(giteaCreatePrForBranch({ branch: 'feat/x', wbsId: '1', itemTitle: 'X', issueNumber: null })).resolves.toBeUndefined();
  });

  it('does not throw when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    await expect(giteaCreatePrForBranch({ branch: 'feat/x', wbsId: '1', itemTitle: 'X', issueNumber: null })).resolves.toBeUndefined();
  });
});
