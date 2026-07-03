import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, LaravelCloudError } from './client.js';
import { createToolkit, type Toolkit } from './toolkit.js';
import { createAdminRouter } from './routes/status.js';
import type { PluginContext } from './types.js';

export const AGENT_ID = '@omadia/agent-laravel-cloud' as const;

const BASE_URL = 'https://cloud.laravel.com/api';
/** Per-request ceiling for tool calls (logs/metrics can be slow upstream). */
const REQUEST_TIMEOUT_MS = 20_000;
/** Soft budget for the activate() self-test so we stay under the 10s limit. */
const SELF_TEST_BUDGET_MS = 8_000;
/** Warn the operator this many days before the token's chosen expiry. */
const EXPIRY_WARN_DAYS = 14;

/**
 * Runtime contract (harness platform v1):
 *   - activate(ctx): 10s budget — self-test is ONE GET, no full crawl.
 *   - close():        5s budget — really release the route mount.
 *   - Return shape is fixed: { toolkit, close() }. LocalSubAgent, tool bridge,
 *     DomainTool wrap, tool-name derivation (→ query_laravel_cloud) and
 *     systemPrompt concat are handled by the runtime. No own LLM client here.
 */
export interface AgentHandle {
  readonly toolkit: Toolkit;
  close(): Promise<void>;
}

function daysUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

export async function activate(ctx: PluginContext): Promise<AgentHandle> {
  ctx.log('activating');

  if (!ctx.http) {
    throw new Error(
      'ctx.http is unavailable — declare permissions.network.outbound: ["cloud.laravel.com"] ' +
        'in manifest.yaml so the platform provides the allow-listed fetch.',
    );
  }

  const apiToken = await ctx.secrets.require('api_token');
  const tokenExpiresAt = ctx.config.get<string>('token_expires_at');

  const client = createClient({
    baseUrl: BASE_URL,
    token: apiToken,
    timeoutMs: REQUEST_TIMEOUT_MS,
    httpFetch: ctx.http.fetch.bind(ctx.http),
    log: ctx.log,
  });

  // --- Self-test: one GET, bounded, never throws out of activate ----------
  const TIMED_OUT = Symbol('self-test-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), SELF_TEST_BUDGET_MS);
  });
  try {
    const result = await Promise.race([client.getOrganization(), budget]);
    if (result === TIMED_OUT) {
      ctx.log('self-test did not complete within budget');
      ctx.status.report({
        state: 'needs_action',
        title: 'Laravel Cloud not verified',
        detail: 'Could not reach Laravel Cloud within the startup budget — check the status page.',
      });
    } else {
      const orgName = (result.name as string | undefined) ?? 'organization';
      const days = daysUntil(tokenExpiresAt);
      if (days != null && days <= 0) {
        ctx.status.report({
          state: 'error',
          title: 'API token expired',
          detail: 'The Laravel Cloud API token has passed its expiry date — rotate it.',
        });
      } else if (days != null && days <= EXPIRY_WARN_DAYS) {
        ctx.status.report({
          state: 'needs_action',
          title: `API token expires in ${days} day(s)`,
          detail: 'Rotate the Laravel Cloud API token soon to avoid an outage.',
        });
      } else {
        ctx.status.report({ state: 'ok', title: `Connected to ${orgName}` });
      }
      ctx.log('self-test ok', { organization: orgName });
    }
  } catch (err) {
    const isTokenErr = err instanceof LaravelCloudError && err.code === 'token_invalid';
    ctx.log('self-test failed', (err as Error).message);
    ctx.status.report({
      state: 'error',
      title: isTokenErr ? 'Invalid API token' : 'Laravel Cloud connection failed',
      detail: (err as Error).message,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const toolkit = createToolkit({ client, log: ctx.log });

  // --- Admin status page ---------------------------------------------------
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiAssetsPath = path.resolve(here, '../assets/admin-ui');
  const router = createAdminRouter({
    client,
    uiAssetsPath,
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    now: () => new Date().toISOString(),
    log: ctx.log,
  });
  const disposeRoute = ctx.routes.register('/api/laravel-cloud/admin', router);
  ctx.log('admin UI mounted at /api/laravel-cloud/admin/index.html');

  return {
    toolkit,
    async close() {
      ctx.log('deactivating');
      try {
        disposeRoute();
      } catch (err) {
        ctx.log('route dispose failed', (err as Error).message);
      }
      await toolkit.close();
    },
  };
}

export default { AGENT_ID, activate };
