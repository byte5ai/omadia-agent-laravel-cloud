# @omadia/agent-laravel-cloud

A **read-only** Laravel Cloud integration (plugin kind `integration`) for
[Omadia](https://omadia.ai), distributed as a standalone plugin via the Hub. It
registers 12 read-only tools; the agent that uses them is yours: the package
ships two inactive agent templates (en/de) you can turn into an agent in the
Agent Builder. Connect a Laravel Cloud API
token and ask about your organization in a shared channel — deployment status &
history, environment / instance health, metrics, runtime & deploy logs, and
resource inventory (apps, environments, database clusters, domains, usage).

> **Read-only by design.** This plugin cannot deploy, run commands, scale,
> restart, or delete anything, and it never returns secret values. See
> [Security](#security).

## What it can answer

- "Did the last deployment to production succeed?"
- "List my applications" / "What environments does app X have?"
- "Show recent error logs for the staging environment" *(needs a time window)*
- "How many instances is the worker running? Are they healthy?"
- "What domains are attached to prod, and is SSL verified?"
- "What environment variables are set on production?" → **names only, no values**
- "What's our usage this period?"

## Setup

1. In the **Laravel Cloud dashboard**, go to **Organization settings → API
   tokens → Create**. Choose an expiry (1 month / 6 months / 1 year). Copy the
   token — Laravel Cloud shows it once.
2. Install this plugin in Omadia and open the install drawer.
3. Paste the token into **Laravel Cloud API token**.
4. *(Optional)* Enter the **Token expiry date** you chose (ISO date, e.g.
   `2026-12-31`) to get a proactive countdown and an early warning on the status
   page. If you leave it blank, an expired token is reported reactively on the
   first failed call.
5. Open the plugin's **status page** to confirm the connection is green
   (organization name, application count, rate-limit headroom, token expiry).

## Security

The Laravel Cloud API token is **account-wide** — it is not scopable to
read-only or to a single application, and it grants full control over your
production infrastructure. Because of that, every safety property here lives in
the plugin, not the credential:

- **Read-only.** There is no mutating tool in this package. The HTTP client only
  ever issues `GET`. To deploy, run, scale, or delete, use the Laravel Cloud
  dashboard.
- **No secrets reach the assistant.** The client strips secret material from
  every response before it is returned: environment-variable **values**,
  database connection credentials, and object-storage key secrets. Environment
  variables are surfaced as **names only**.
- **Untrusted content.** Logs, commit messages, and resource names returned by
  the API are treated as data, never as instructions to the assistant.
- **Token storage.** The token is stored only in Omadia's encrypted vault
  (AES-256-GCM) and is never shown to the assistant or logged.

**Rotate the token on the schedule you chose at creation.** The status page
warns as expiry approaches (when you provide the expiry date). Laravel Cloud
tokens do not auto-refresh; an expired token surfaces as an actionable
`token_invalid` error.

## Development

```bash
npm install          # peers (zod, express) + dev tooling; .npmrc sets legacy-peer-deps
npm run typecheck    # tsc --noEmit
npm test             # vitest — client secret-stripping / pagination / errors / truncation
npm run build        # tsc → dist/, then zip → out/@omadia-agent-laravel-cloud-<version>.zip
```

The build artifact in `out/` is the uploadable package: install it locally via
the Store → Local tab, or publish it to `hub.omadia.ai`.

### Layout

| Path | Purpose |
|---|---|
| `manifest.yaml` | Declarative plugin definition (schema v1); 12 read-only capabilities (`side_effects: read`) and the `agent_templates`. |
| `client.ts` | LLM-free Laravel Cloud HTTP client — pagination, secret-stripping, error mapping. Unit-tested. |
| `toolkit.ts` | The 12 read-only tools (Zod inputs → client calls). |
| `registerTools.ts` | Registers every tool via `ctx.tools.register`. |
| `routes/status.ts` | Admin status-page router (`/api/laravel-cloud/admin`). |
| `plugin.ts` | `activate()` returns `{ close }` — client construction, self-test, tool registration, route mount. |
| `assets/admin-ui/index.html` | Single-file operator status page. |
| `types.ts` | Local `PluginContext` duplicate (the package compiles standalone). |

All runtime HTTP goes through `ctx.http.fetch` (platform outbound allow-list +
SSRF guard + 60 req/min bucket). The plugin only ever calls
`cloud.laravel.com`.

## License

MIT © byte5 GmbH
