import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { activate } from '../plugin';
import { createToolkit } from '../toolkit';
import type { PluginContext, NativeToolSpec } from '../types';

const manifest = readFileSync(new URL('../manifest.yaml', import.meta.url), 'utf8');

function fakeCtx(registered: NativeToolSpec[], disposed: string[]): PluginContext {
  const ok = new Response(JSON.stringify({ data: { attributes: { name: 'Acme', slug: 'acme' } } }), {
    status: 200,
    headers: { 'content-type': 'application/vnd.api+json' },
  });
  return {
    agentId: '@omadia/agent-laravel-cloud',
    secrets: { require: async () => 'tok', get: async () => 'tok', keys: async () => [] },
    config: { get: () => undefined, require: () => undefined as never },
    services: { get: () => undefined, has: () => false, provide: () => () => {} },
    routes: { register: () => () => {} },
    uiRoutes: { register: () => () => {} },
    http: { fetch: async () => ok.clone() },
    tools: {
      register: (spec) => {
        registered.push(spec);
        return () => disposed.push(spec.name);
      },
    },
    status: { report: () => {} } as never,
    jobs: { register: () => () => {} } as never,
    smokeMode: false,
    log: () => {},
  } as unknown as PluginContext;
}

describe('capability plugin shape', () => {
  it('registers every tool via ctx.tools.register and unregisters them on close', async () => {
    const registered: NativeToolSpec[] = [];
    const disposed: string[] = [];
    const handle = await activate(fakeCtx(registered, disposed));
    expect(Object.keys(handle)).toEqual(['close']);
    expect(registered).toHaveLength(12);
    for (const spec of registered) expect(spec.input_schema.type).toBe('object');
    await handle.close();
    expect(disposed.sort()).toEqual(registered.map((s) => s.name).sort());
  });

  it('declares a side_effects entry (read) for every registered tool', () => {
    const toolkit = createToolkit({ client: { dispose: async () => {} } as never, log: () => {} });
    for (const tool of toolkit.tools) {
      const block = manifest.split(`- id: "${tool.id}"`)[1]?.split('\n  - id:')[0] ?? '';
      expect(block, tool.id).toContain('side_effects: "read"');
    }
  });

  it('is no longer a persona-bearing agent plugin', () => {
    expect(manifest).toContain('kind: "integration"');
    expect(manifest).not.toMatch(/kind: "agent"/);
    expect(manifest).not.toContain('prompt_partial');
    expect(manifest).not.toMatch(/^llm:/m);
    expect(manifest).toMatch(/^agent_templates:/m);
  });
});
