import { describe, it, expect } from 'vitest';
import { createClient, sanitize, LaravelCloudError } from '../client';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/vnd.api+json', ...headers },
  });
}

function makeClient(httpFetch: FetchFn) {
  return createClient({
    baseUrl: 'https://cloud.laravel.com/api',
    token: 'super-secret-bearer-token',
    timeoutMs: 5000,
    httpFetch,
    log: () => {},
  });
}

// ---------------------------------------------------------------------------
// Secret stripping (L5 / FR-H3) — the whole safety story
// ---------------------------------------------------------------------------

describe('sanitize()', () => {
  it('keeps env-variable names but drops their values', () => {
    const out = sanitize({
      environment_variables: [
        { key: 'APP_KEY', value: 'base64:hunter2' },
        { key: 'DB_PASSWORD', value: 'p@ss' },
      ],
    });
    expect(out).toEqual({
      environment_variables: [{ key: 'APP_KEY' }, { key: 'DB_PASSWORD' }],
    });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('p@ss');
  });

  it('redacts a whole DB connection object (username + password)', () => {
    expect(
      sanitize({ connection: { hostname: 'h', port: 5432, username: 'u', password: 'p' } }),
    ).toEqual({ connection: '[redacted: database connection credentials]' });
  });

  it('drops storage-key secrets and generic secret/token/password keys', () => {
    expect(sanitize({ name: 'k', access_key_secret: 'zzz' })).toEqual({ name: 'k' });
    expect(sanitize({ keep: 1, api_token: 't', client_secret: 's', privateKey: 'k' })).toEqual({
      keep: 1,
    });
  });

  it('recurses into nested objects and arrays', () => {
    expect(sanitize({ a: [{ password: 'x', ok: 1 }], b: { c: { secret_value: 'y', d: 2 } } })).toEqual(
      { a: [{ ok: 1 }], b: { c: { d: 2 } } },
    );
  });
});

function isFlatRow(row: Record<string, unknown>): boolean {
  // No cell is a plain object or an array-of-objects (both render as "[nested]"
  // / "[N records]" in the platform's tabular tool-result renderer).
  return Object.values(row).every((v) => {
    if (v === null || typeof v !== 'object') return true;
    if (Array.isArray(v)) {
      return v.every((e) => e === null || typeof e !== 'object');
    }
    return false;
  });
}

describe('getEnvironment integration', () => {
  it('flattens to a display row: env-variable NAMES only, no values, no nesting', async () => {
    const client = makeClient(async () =>
      jsonResponse({
        data: {
          id: 'env1',
          type: 'environment',
          attributes: {
            name: 'production',
            region: 'eu-central-1',
            environment_variables: [
              { key: 'APP_KEY', value: 'leak-me' },
              { key: 'DB_PASSWORD', value: 'nope' },
            ],
            network_settings: { cache: { strategy: 'aggressive' } },
          },
        },
      }),
    );
    const res = await client.getEnvironment('env1');
    // Attributes hoisted to the top level (not res.attributes.name).
    expect(res.name).toBe('production');
    expect(res.region).toBe('eu-central-1');
    // Env vars become a scalar name-array; values are gone.
    expect(res.environment_variables).toEqual(['APP_KEY', 'DB_PASSWORD']);
    expect(JSON.stringify(res)).not.toContain('leak-me');
    // Nested config object is hoisted, never left as a nested cell.
    expect(isFlatRow(res)).toBe(true);
  });
});

describe('flat output shape (no "[nested]" cells)', () => {
  it('list rows are flat records of scalars / scalar-arrays', async () => {
    const client = makeClient(async () =>
      jsonResponse({
        data: [
          {
            id: 'app-1',
            type: 'application',
            attributes: { name: 'Store', slug: 'store', region: 'eu-west-1', repository: { provider: 'github', name: 'acme/store' } },
          },
        ],
        links: { next: null },
        meta: { last_page: 1 },
      }),
    );
    const res = await client.listApplications();
    expect(res.items).toHaveLength(1);
    const row = res.items[0]!;
    expect(row.name).toBe('Store');
    expect(row.id).toBe('app-1');
    // Nested `repository` object hoisted to repository_provider / repository_name.
    expect(row.repository_provider).toBe('github');
    expect(row.repository_name).toBe('acme/store');
    expect(isFlatRow(row)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pagination caps (FR-H2 / FR-H5)
// ---------------------------------------------------------------------------

describe('pagination', () => {
  it('caps a single oversized page at MAX_LIST_ITEMS and marks truncated', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: String(i),
      type: 'application',
      attributes: { name: `app${i}` },
    }));
    const client = makeClient(async () =>
      jsonResponse({ data: items, links: { next: null }, meta: { last_page: 1 } }),
    );
    const res = await client.listApplications();
    expect(res.items).toHaveLength(200);
    expect(res.truncated).toBe(true);
  });

  it('stops following links.next at the page cap', async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      const page = calls;
      return jsonResponse({
        data: [{ id: `a${page}`, type: 'application', attributes: {} }],
        links: { next: page < 10 ? `https://cloud.laravel.com/api/applications?page=${page + 1}` : null },
        meta: { last_page: 10 },
      });
    });
    const res = await client.listApplications();
    expect(calls).toBe(5); // DEFAULT_PAGE_CAP
    expect(res.items).toHaveLength(5);
    expect(res.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error mapping (FR-H4) — typed, actionable, no token leak
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  const cases: Array<[number, string]> = [
    [400, 'bad_request'],
    [401, 'token_invalid'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'upstream_error'],
    [503, 'upstream_error'],
  ];
  for (const [status, code] of cases) {
    it(`maps HTTP ${status} → ${code}`, async () => {
      const client = makeClient(async () => jsonResponse({ message: 'x' }, status));
      await expect(client.getOrganization()).rejects.toMatchObject({ code });
    });
  }

  it('maps 429 → rate_limited with retry-after seconds', async () => {
    const client = makeClient(async () =>
      jsonResponse({ message: 'slow down' }, 429, { 'retry-after': '30' }),
    );
    await expect(client.getOrganization()).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 30,
    });
  });

  it('never includes the bearer token in the error message', async () => {
    const client = makeClient(async () => jsonResponse({ message: 'unauthorized' }, 401));
    let thrown: LaravelCloudError | undefined;
    try {
      await client.getOrganization();
    } catch (err) {
      thrown = err as LaravelCloudError;
    }
    expect(thrown).toBeInstanceOf(LaravelCloudError);
    expect(thrown!.message).not.toContain('super-secret-bearer-token');
    expect(thrown!.message).toMatch(/rotate/i);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit capture + clean database path
// ---------------------------------------------------------------------------

describe('rate-limit + endpoints', () => {
  it('captures rate-limit headers for the status page', async () => {
    const client = makeClient(async () =>
      jsonResponse(
        { data: { id: 'o', type: 'organization', attributes: { name: 'Acme' } } },
        200,
        { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59' },
      ),
    );
    await client.getOrganization();
    expect(client.rateLimit()).toMatchObject({ limit: 60, remaining: 59 });
  });

  it('lists database CLUSTERS and never requests include=database', async () => {
    let seenUrl = '';
    const client = makeClient(async (url) => {
      seenUrl = url;
      return jsonResponse({ data: [], links: { next: null }, meta: { last_page: 1 } });
    });
    await client.listDatabaseClusters();
    expect(seenUrl).toContain('/databases/clusters');
    expect(seenUrl).not.toContain('include=database');
  });
});

// ---------------------------------------------------------------------------
// Truncation of free-form bodies (FR-H5)
// ---------------------------------------------------------------------------

describe('truncation', () => {
  it('truncates large log arrays with an explicit marker', async () => {
    const big = Array.from({ length: 250 }, (_, i) => ({ message: `log${i}`, level: 'info' }));
    const client = makeClient(async () => jsonResponse({ data: big }));
    const res = (await client.listEnvironmentLogs('env1', {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
    })) as unknown[];
    expect(res).toHaveLength(101); // 100 lines + marker
    expect(res[100]).toHaveProperty('_truncated');
  });

  it('truncates very long strings', async () => {
    const long = 'x'.repeat(5000);
    const client = makeClient(async () => jsonResponse({ data: { message: long } }));
    const res = (await client.getDeploymentLogs('d1')) as { message: string };
    expect(res.message.length).toBeLessThan(5000);
    expect(res.message).toContain('truncated');
  });
});
