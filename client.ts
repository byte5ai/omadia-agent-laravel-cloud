/**
 * Laravel Cloud API client — read-only.
 *
 * Pure business logic against https://cloud.laravel.com/api. No LLM/Zod code
 * here (that lives in toolkit.ts) so the client is unit-testable with a mocked
 * fetch. Every request goes through an injected `httpFetch` (the platform's
 * `ctx.http.fetch`: outbound allow-list + SSRF guard + 60 req/min bucket) —
 * never the global `fetch`.
 *
 * SECURITY INVARIANTS (see spec 006, L5 / FR-H3):
 *   - This client only ever issues GET. Read-only is enforced by construction.
 *   - Every response passes through `sanitize()` before it is returned, so no
 *     secret material (env-variable VALUES, DB credentials, storage-key
 *     secrets, any password / secret / token field) can reach the caller —
 *     and therefore never reaches the LLM. This is the whole safety story:
 *     the Laravel Cloud token is un-scopable god-mode, so the plugin, not the
 *     credential, is the only line of defense.
 */

// Media type — verified against the OpenAPI (resources are JSON:API).
const ACCEPT = 'application/vnd.api+json';
const USER_AGENT = '@omadia/agent-laravel-cloud (read-only ops copilot)';

// Follow at most this many JSON:API pages per list call (FR-H2). Beyond it,
// the result is returned `truncated: true` rather than fanned out unbounded.
const DEFAULT_PAGE_CAP = 5;
// Hard ceilings so a single tool call stays bounded (FR-H5).
const MAX_LIST_ITEMS = 200;
const MAX_LOG_LINES = 100;
const MAX_STRING_CHARS = 4000;

// ---------------------------------------------------------------------------
// Errors — typed + actionable, never leak the token (FR-H4)
// ---------------------------------------------------------------------------

export type LaravelCloudErrorCode =
  | 'token_invalid'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'bad_request'
  | 'upstream_error'
  | 'network_error';

export class LaravelCloudError extends Error {
  readonly code: LaravelCloudErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: LaravelCloudErrorCode,
    message: string,
    opts: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'LaravelCloudError';
    this.code = code;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

function mapStatusToError(
  status: number,
  serverMessage: string,
  retryAfterSeconds?: number,
): LaravelCloudError {
  const detail = serverMessage ? ` (${serverMessage.slice(0, 200)})` : '';
  switch (status) {
    case 400:
      return new LaravelCloudError('bad_request', `Bad request${detail}`, { status });
    case 401:
      return new LaravelCloudError(
        'token_invalid',
        'Laravel Cloud token is invalid or expired — rotate it in the Laravel ' +
          'Cloud dashboard (Organization settings → API tokens) and update the ' +
          'plugin secret.',
        { status },
      );
    case 403:
      return new LaravelCloudError(
        'forbidden',
        `The token is not permitted to read this resource${detail}.`,
        { status },
      );
    case 404:
      return new LaravelCloudError('not_found', `Resource not found${detail}.`, { status });
    case 429:
      return new LaravelCloudError(
        'rate_limited',
        retryAfterSeconds != null
          ? `Rate limited by Laravel Cloud — retry after ${retryAfterSeconds}s.`
          : 'Rate limited by Laravel Cloud — retry shortly.',
        { status, retryAfterSeconds },
      );
    default:
      if (status >= 500) {
        return new LaravelCloudError('upstream_error', `Laravel Cloud error ${status}${detail}.`, {
          status,
        });
      }
      return new LaravelCloudError('upstream_error', `Unexpected status ${status}${detail}.`, {
        status,
      });
  }
}

// ---------------------------------------------------------------------------
// Secret stripping — the single choke-point (L5 / FR-H3)
// ---------------------------------------------------------------------------

// Drop any key whose name matches a secret-bearing pattern. Verified concrete
// leaves: `access_key_secret` (storage keys), `password`/`username` (DB
// `connection`), and anything matching *secret*/*password*/*private_key*.
const SECRET_KEY_RE = /(password|secret|passwd|private[_-]?key|client[_-]?secret)/i;
const SECRET_EXACT = new Set(['token', 'access_token', 'refresh_token', 'api_token']);

/**
 * Deep-walk a parsed JSON value and remove every secret-bearing field before
 * it leaves the client. Conservative by default: an unknown field that matches
 * a secret pattern is dropped, not passed through.
 *
 *  - `environment_variables: [{ key, value }]` → keep `key`, drop `value`
 *    (env vars surface as NAMES ONLY, never values).
 *  - `connection` (DB credentials object) → replaced with a redaction marker.
 *  - any `*password*` / `*secret*` / `*private_key*` / bare token key → dropped.
 */
export function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // Whole-object credential blobs — never expose, even structurally.
      if (key === 'connection') {
        out[key] = '[redacted: database connection credentials]';
        continue;
      }
      // Env-variable values: names only.
      if (key === 'environment_variables' && Array.isArray(value)) {
        out[key] = value.map((entry) => {
          if (entry !== null && typeof entry === 'object' && 'key' in (entry as object)) {
            return { key: (entry as Record<string, unknown>).key };
          }
          return sanitize(entry);
        });
        continue;
      }
      // Generic secret-key defense.
      if (SECRET_KEY_RE.test(key) || SECRET_EXACT.has(key.toLowerCase())) {
        continue;
      }
      out[key] = sanitize(value);
    }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface CloudResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

export interface CloudList {
  items: CloudResource[];
  /** True if a page/size cap stopped the walk before the API ran out of data. */
  truncated: boolean;
  /** JSON:API paginator total, when the API reports one. */
  totalPages?: number | null;
}

export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  /** Seconds until the window resets, when the API tells us. */
  resetSeconds: number | null;
  observedAt: number;
}

export type MetricPeriod = '6h' | '24h' | '3d' | '7d' | '30d';

export interface EnvironmentLogQuery {
  from: string;
  to: string;
  type?: 'all' | 'application' | 'access';
  query?: string;
  cursor?: string;
}

export interface LaravelCloudClient {
  /** Self-test target: organization name + slug (secret-free). */
  getOrganization(): Promise<CloudResource>;
  getUsage(period?: number, environment?: string): Promise<unknown>;

  listApplications(filter?: { name?: string; region?: string }): Promise<CloudList>;
  getApplication(application: string): Promise<CloudResource>;
  listEnvironments(application: string): Promise<CloudList>;
  getEnvironment(environment: string): Promise<CloudResource>;
  listDeployments(
    environment: string,
    filter?: { status?: string; branch_name?: string },
  ): Promise<CloudList>;
  getDeployment(deployment: string): Promise<CloudResource>;
  getDeploymentLogs(deployment: string): Promise<unknown>;
  getEnvironmentMetrics(environment: string, period?: MetricPeriod): Promise<unknown>;
  listEnvironmentLogs(environment: string, q: EnvironmentLogQuery): Promise<unknown>;
  listInstances(environment: string): Promise<CloudList>;
  listDatabaseClusters(): Promise<CloudList>;
  listDomains(environment: string): Promise<CloudList>;

  /** Last-seen rate-limit headers, for the admin status page. */
  rateLimit(): RateLimitSnapshot | null;
  dispose(): Promise<void>;
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  /** Bound `ctx.http.fetch` — the ONLY egress path. */
  httpFetch: (url: string, init?: RequestInit) => Promise<Response>;
  log: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function truncateStrings(node: unknown): unknown {
  if (typeof node === 'string') {
    return node.length > MAX_STRING_CHARS
      ? `${node.slice(0, MAX_STRING_CHARS)}… [truncated ${node.length - MAX_STRING_CHARS} chars]`
      : node;
  }
  if (Array.isArray(node)) return node.map(truncateStrings);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = truncateStrings(v);
    }
    return out;
  }
  return node;
}

function toResource(raw: unknown): CloudResource {
  const clean = sanitize(raw) as Record<string, unknown>;
  return {
    id: String(clean.id ?? ''),
    type: String(clean.type ?? ''),
    attributes: (clean.attributes as Record<string, unknown>) ?? {},
    ...(clean.relationships
      ? { relationships: clean.relationships as Record<string, unknown> }
      : {}),
  };
}

export function createClient(opts: ClientOptions): LaravelCloudClient {
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: ACCEPT,
    'User-Agent': USER_AGENT,
  };

  let lastRateLimit: RateLimitSnapshot | null = null;

  function captureRateLimit(res: Response): void {
    const limit = res.headers.get('x-ratelimit-limit');
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset') ?? res.headers.get('retry-after');
    if (limit == null && remaining == null && reset == null) return;
    lastRateLimit = {
      limit: limit != null ? Number(limit) : null,
      remaining: remaining != null ? Number(remaining) : null,
      resetSeconds: reset != null ? Number(reset) : null,
      observedAt: Date.now(),
    };
  }

  function buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${opts.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  /** Low-level GET → parsed JSON:API envelope. Handles timeout, rate-limit
   *  capture, and error mapping. `url` is a fully-qualified cloud.laravel.com
   *  URL (also used to follow `links.next` verbatim during pagination). */
  async function requestUrl<T = unknown>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await opts.httpFetch(url, {
        method: 'GET',
        headers: baseHeaders,
        signal: controller.signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        throw new LaravelCloudError('network_error', `Request timed out after ${opts.timeoutMs}ms.`);
      }
      throw new LaravelCloudError('network_error', `Network error: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    captureRateLimit(res);

    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after');
      let serverMessage = '';
      try {
        const body = (await res.json()) as { message?: string };
        serverMessage = typeof body?.message === 'string' ? body.message : '';
      } catch {
        serverMessage = '';
      }
      throw mapStatusToError(
        res.status,
        serverMessage,
        retryAfter != null ? Number(retryAfter) : undefined,
      );
    }

    return (await res.json()) as T;
  }

  type Envelope = {
    data?: unknown;
    links?: { next?: string | null };
    meta?: { last_page?: number | null };
  };

  /** GET one resource → sanitized `CloudResource`. */
  async function getOne(path: string, query?: Record<string, string | undefined>): Promise<CloudResource> {
    const body = await requestUrl<Envelope>(buildUrl(path, query));
    return toResource(body.data ?? {});
  }

  /** GET a paginated collection → sanitized items, capped (FR-H2/FR-H5). */
  async function getMany(
    path: string,
    query?: Record<string, string | undefined>,
    pageCap = DEFAULT_PAGE_CAP,
  ): Promise<CloudList> {
    let url: string | null = buildUrl(path, query);
    const items: CloudResource[] = [];
    let pages = 0;
    let totalPages: number | null | undefined;
    let truncated = false;

    while (url) {
      const body: Envelope = await requestUrl<Envelope>(url);
      totalPages = body.meta?.last_page ?? totalPages;
      const data = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
      for (const entry of data) {
        if (items.length >= MAX_LIST_ITEMS) {
          truncated = true;
          break;
        }
        items.push(toResource(entry));
      }
      pages += 1;
      const next = body.links?.next ?? null;
      if (truncated || !next) {
        url = null;
      } else if (pages >= pageCap) {
        truncated = true;
        url = null;
      } else {
        url = next;
      }
    }

    return { items, truncated, totalPages: totalPages ?? null };
  }

  /** GET a raw (non-JSON:API-list) payload → sanitized + string-truncated. For
   *  metrics/usage/logs whose shapes are free-form; we never inspect them, we
   *  just pass the secret-stripped, size-bounded body through. */
  async function getRaw(
    path: string,
    query?: Record<string, string | undefined>,
    maxItems = MAX_LOG_LINES,
  ): Promise<unknown> {
    const body = await requestUrl<Envelope>(buildUrl(path, query));
    const payload = 'data' in body ? body.data : body;
    let sanitized = sanitize(payload);
    if (Array.isArray(sanitized) && sanitized.length > maxItems) {
      sanitized = [
        ...sanitized.slice(0, maxItems),
        { _truncated: `showing first ${maxItems} of ${sanitized.length} entries` },
      ];
    }
    return truncateStrings(sanitized);
  }

  return {
    getOrganization() {
      return getOne('/meta/organization');
    },
    getUsage(period, environment) {
      return getRaw('/usage', {
        period: period != null ? String(period) : undefined,
        environment,
      });
    },
    listApplications(filter) {
      return getMany('/applications', {
        'filter[name]': filter?.name,
        'filter[region]': filter?.region,
      });
    },
    getApplication(application) {
      return getOne(`/applications/${encodeURIComponent(application)}`);
    },
    listEnvironments(application) {
      return getMany(`/applications/${encodeURIComponent(application)}/environments`);
    },
    getEnvironment(environment) {
      return getOne(`/environments/${encodeURIComponent(environment)}`);
    },
    listDeployments(environment, filter) {
      return getMany(`/environments/${encodeURIComponent(environment)}/deployments`, {
        'filter[status]': filter?.status,
        'filter[branch_name]': filter?.branch_name,
      });
    },
    getDeployment(deployment) {
      return getOne(`/deployments/${encodeURIComponent(deployment)}`);
    },
    getDeploymentLogs(deployment) {
      return getRaw(`/deployments/${encodeURIComponent(deployment)}/logs`);
    },
    getEnvironmentMetrics(environment, period) {
      return getRaw(`/environments/${encodeURIComponent(environment)}/metrics`, { period });
    },
    listEnvironmentLogs(environment, q) {
      return getRaw(`/environments/${encodeURIComponent(environment)}/logs`, {
        from: q.from,
        to: q.to,
        type: q.type,
        query: q.query,
        cursor: q.cursor,
      });
    },
    listInstances(environment) {
      return getMany(`/environments/${encodeURIComponent(environment)}/instances`);
    },
    listDatabaseClusters() {
      // Non-deprecated cluster path — ClusterResource carries NO `connection`
      // credentials (unlike the deprecated flat /databases). We never request
      // `include=database`, which would pull the credentialed connection in.
      return getMany('/databases/clusters');
    },
    listDomains(environment) {
      return getMany(`/environments/${encodeURIComponent(environment)}/domains`);
    },
    rateLimit() {
      return lastRateLimit;
    },
    async dispose() {
      // No keep-alive sockets held; nothing to release.
    },
  };
}
