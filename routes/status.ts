import express from 'express';
import {
  LaravelCloudError,
  type LaravelCloudClient,
  type RateLimitSnapshot,
} from '../client.js';

/** Days from now until an ISO date; null if the date is unparseable. */
function daysUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

export interface AdminStatusPayload {
  tokenState: 'ok' | 'token_invalid' | 'error';
  organizationName: string | null;
  applicationCount: number | null;
  applicationCountTruncated: boolean;
  rateLimit: RateLimitSnapshot | null;
  tokenExpiresAt: string | null;
  daysToExpiry: number | null;
  message: string | null;
  checkedAt: string;
}

export interface AdminRouterOptions {
  client: LaravelCloudClient;
  uiAssetsPath: string;
  tokenExpiresAt?: string;
  /** Injected clock for testability; defaults to the real one. */
  now: () => string;
  log: (...args: unknown[]) => void;
}

/**
 * Build the admin router mounted at `/api/laravel-cloud/admin`:
 *   - static single-file admin UI (index.html)
 *   - GET api/status → { ok: true, status } (envelope contract)
 *
 * The status endpoint runs at most two cheap GETs (organization + a capped
 * application list) so the page reflects LIVE token validity, not just the
 * activate()-time snapshot. Its `ok` reflects endpoint health; an invalid
 * token is reported as `ok:true` with `status.tokenState='token_invalid'`.
 */
export function createAdminRouter(opts: AdminRouterOptions): express.Router {
  const router = express.Router();

  // `redirect: false` is critical — otherwise trailing-slash + the /bot-api
  // rewrite + express.static's default redirect form a 3-hop chain that
  // breaks the iframe load.
  router.use(express.static(opts.uiAssetsPath, { redirect: false }));

  router.get('/api/status', async (_req, res) => {
    const tokenExpiresAt = opts.tokenExpiresAt ?? null;
    const daysToExpiry = daysUntil(opts.tokenExpiresAt);
    try {
      const org = await opts.client.getOrganization();
      const organizationName = (org.name as string | undefined) ?? null;

      let applicationCount: number | null = null;
      let applicationCountTruncated = false;
      try {
        const apps = await opts.client.listApplications();
        applicationCount = apps.items.length;
        applicationCountTruncated = apps.truncated;
      } catch (err) {
        opts.log('status: application count failed', (err as Error).message);
      }

      const payload: AdminStatusPayload = {
        tokenState: 'ok',
        organizationName,
        applicationCount,
        applicationCountTruncated,
        rateLimit: opts.client.rateLimit(),
        tokenExpiresAt,
        daysToExpiry,
        message: null,
        checkedAt: opts.now(),
      };
      res.json({ ok: true, status: payload });
    } catch (err) {
      const isTokenErr = err instanceof LaravelCloudError && err.code === 'token_invalid';
      const payload: AdminStatusPayload = {
        tokenState: isTokenErr ? 'token_invalid' : 'error',
        organizationName: null,
        applicationCount: null,
        applicationCountTruncated: false,
        rateLimit: opts.client.rateLimit(),
        tokenExpiresAt,
        daysToExpiry,
        message: (err as Error).message,
        checkedAt: opts.now(),
      };
      // The endpoint itself succeeded; the token problem is data, not a 5xx.
      res.json({ ok: true, status: payload });
    }
  });

  return router;
}
