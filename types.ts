/**
 * Structurally compatible with middleware/src/platform/pluginContext.ts —
 * deliberately duplicated so the package compiles standalone WITHOUT a
 * cross-import. Precondition for the zip-upload flow: the package must not
 * reference anything outside its own tree.
 *
 * On a breaking change to the host interface: carry this file forward in all
 * packages — that is intent, not an accident (structural boundary).
 */

export interface PluginContext {
  readonly agentId: string;
  readonly secrets: {
    get(key: string): Promise<string | undefined>;
    require(key: string): Promise<string>;
    keys(): Promise<string[]>;
    set?(key: string, value: string): Promise<void>;
    delete?(key: string): Promise<void>;
  };
  readonly config: {
    get<T = unknown>(key: string): T | undefined;
    require<T = unknown>(key: string): T;
    set?(key: string, value: unknown): Promise<void>;
  };
  /** Cross-plugin service registry (unused by this self-contained agent). */
  readonly services: {
    get<T>(name: string): T | undefined;
    has(name: string): boolean;
    provide<T>(name: string, impl: T): () => void;
  };
  /** Express-router mount-point for the admin status page + its JSON API.
   *  `register(prefix, router)` returns a dispose handle that close() MUST
   *  invoke to symmetrically unmount on deactivate. In Preview this is a
   *  no-op stub; the real mount happens at install-time. */
  readonly routes: {
    register(prefix: string, router: unknown): () => void;
  };
  readonly uiRoutes: {
    register(descriptor: UiRouteDescriptorInput): () => void;
  };
  /** HTTP client with manifest-enforced outbound allow-listing and
   *  per-plugin rate limiting (60 requests/min). Present iff the manifest
   *  declares `permissions.network.outbound` with at least one host. Calls
   *  to undeclared hosts throw `HttpForbiddenError`; rate-limit breaches
   *  throw `HttpRateLimitError`. Prefer `ctx.http.fetch(...)` over global
   *  `fetch` so the plugin stays future-proof. */
  readonly http?: HttpAccessor;

  /** Tool runtime (spec 2042 §5.10): register every tool with the kernel.
   *  `register` returns a dispose handle that close() MUST invoke. */
  readonly tools: ToolsAccessor;

  readonly subAgent?: SubAgentAccessor;
  readonly knowledgeGraph?: KnowledgeGraphAccessor;
  readonly llm?: LlmAccessor;
  readonly flows?: FlowsAccessor;

  /** Operator-facing action status. The admin UI renders it as a badge on
   *  the plugin card + a banner on the detail page, clearing on `ok`. Always
   *  present; re-report on `activate()` (in-memory, self-heals on restart). */
  readonly status: StatusAccessor;

  readonly oauthTokens?: OAuthTokensAccessor;
  readonly memory?: MemoryAccessor;
  readonly jobs: JobsAccessor;

  /** True only when the kernel activated this plugin for a smoke probe. */
  readonly smokeMode: boolean;
  log(...args: unknown[]): void;
}

export interface MemoryAccessor {
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  createFile(relPath: string, content: string): Promise<void>;
  delete(relPath: string): Promise<void>;
  list(relPath: string): Promise<readonly MemoryEntryInfo[]>;
  exists(relPath: string): Promise<boolean>;
}

export interface MemoryEntryInfo {
  readonly relPath: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
}

export interface FlowsAccessor {
  publicUrl(relPath: string, opts?: { prefix?: string }): string;
  signState(
    claims: Record<string, unknown>,
    opts?: { ttl?: string },
  ): Promise<string>;
  verifyState(token: string): Promise<Record<string, unknown>>;
}

export type PluginActionState = 'ok' | 'needs_action' | 'error';

export interface PluginActionStatus {
  readonly state: PluginActionState;
  readonly title?: string;
  readonly detail?: string;
}

export interface StatusAccessor {
  report(status: PluginActionStatus): void;
  clear(): void;
}

export interface OAuthTokensAccessor {
  get(fieldKey: string): Promise<string>;
}

export type OAuthTokenErrorCode = 'not_connected' | 'refresh_failed';

export type JobSchedule =
  | { readonly cron: string }
  | { readonly intervalMs: number };

export interface JobSpec {
  readonly name: string;
  readonly schedule: JobSchedule;
  readonly timeoutMs?: number;
  readonly overlap?: 'skip' | 'queue';
}

export type JobHandler = (signal: AbortSignal) => Promise<void>;

export interface JobsAccessor {
  register(spec: JobSpec, handler: JobHandler): () => void;
}

export interface UiRouteDescriptorInput {
  readonly routeId: string;
  readonly path: string;
  readonly title: string;
  readonly description?: string;
  readonly order?: number;
}

/** Outbound-allowlisted fetch. Same shape as global `fetch`; unknown hosts
 *  throw `HttpForbiddenError`, rate-limit breaches throw `HttpRateLimitError`. */
export interface HttpAccessor {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface SubAgentAccessor {
  ask(targetAgentId: string, question: string): Promise<string>;
  has(targetAgentId: string): boolean;
  list(): readonly string[];
}

export interface LlmCompleteRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface LlmCompleteResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
}

export interface LlmAccessor {
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
  readonly modelsAllowed: readonly string[];
}

export interface EntityIngest {
  readonly system: string;
  readonly model: string;
  readonly id: string;
  readonly displayName: string;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface EntityIngestResult {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
}

export interface FactIngest {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence?: number;
  readonly mentionedEntityIds?: readonly string[];
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface FactIngestResult {
  readonly inserted: number;
}

export interface KnowledgeGraphAccessor {
  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult>;
  ingestFacts(facts: FactIngest[]): Promise<FactIngestResult>;
  searchTurns(opts: Readonly<Record<string, unknown>>): Promise<readonly unknown[]>;
  findEntityCapturedTurns(
    opts: Readonly<Record<string, unknown>>,
  ): Promise<readonly unknown[]>;
  getNeighbors(nodeId: string): Promise<readonly unknown[]>;
  stats(): Promise<Readonly<Record<string, number>>>;
  readonly entitySystems: readonly string[];
}

/** Spec of one tool registered via `ctx.tools.register`. */
export interface NativeToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

/** Handler of a registered tool; the returned string is the tool result. */
export type NativeToolHandler = (input: unknown) => Promise<string>;

export interface ToolsAccessor {
  register(spec: NativeToolSpec, handler: NativeToolHandler): () => void;
}
