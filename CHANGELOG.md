# Changelog

## 0.2.0

Migration off the retired plugin kind `agent` (spec 2042 §5.10, ADR-0014).

- `identity.kind` is now `integration` (the plugin owns its Laravel Cloud
  token). Plugin id unchanged.
- Tool names are prefixed with `laravel_cloud_` (`laravel_cloud_list_applications`,
  `laravel_cloud_get_deployment`, ...). They were internal to the sub-agent
  before; as instance-wide tools generic names would collide.
- Tools are registered via `ctx.tools.register` (`registerTools.ts`);
  `activate()` returns `{ close }` instead of a toolkit. Tool names unchanged.
- `skills/laravel-cloud-expert.md` (`prompt_partial`) is gone. Its tool
  knowledge moved into the tool descriptions and `playbook.when_to_use`; the
  persona ships as two inactive `agent_templates` (en, de).
- `llm:` preferences removed (the plugin never called a model).
- Every capability declares `side_effects: "read"`.
- `compat.core` is `>=1.75.0 <2.0`: older kernels cannot load the new kinds or
  `agent_templates`.
- Local `PluginContext` duplicate gained `tools`.
- Added `test/plugin.test.ts`.

## 0.1.1

Previous release (read-only ops copilot, kind `agent`).
