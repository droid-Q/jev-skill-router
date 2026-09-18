# Jev Skill Router for Codex

**English** | [简体中文](README-cn.md)

A Codex plugin that asks [TypeSafe Jev](https://typesafe.ai/) which skills fit each user prompt, then supplies the selected skills to Codex through a `UserPromptSubmit` hook.

```text
User prompt → Codex skills/list → Jev relevance probabilities → selected SKILL.md paths → Codex
```

This is automatic routing through a supported lifecycle hook. Codex does not expose a dedicated `SkillSelect` event: the plugin adds selection instructions to the model's context, rather than replacing or enforcing Codex's internal skill registry. It does not remove the initial skill catalog from the context or guarantee token savings.

## Requirements

- Codex CLI with plugin hooks, `UserPromptSubmit`, and app-server `skills/list`. Developed against **0.154.0**.
- **Node.js 22+** available to the process running Codex.
- A TypeSafe API key with access to Jev.

The shipped hook is bundled. Plugin users do **not** need `npm install`, Python, an MCP server, or a separate background service.

## Install

```sh
codex plugin marketplace add https://github.com/droid-Q/jev-skill-router.git
codex plugin add jev-skill-router@jev-skill-router
```

Configure the key as described below. Open `/hooks` in the Codex CLI and review/trust this plugin's `UserPromptSubmit` command. Installing a plugin does not automatically trust its hooks. Start a new Codex task after installation; the desktop app and CLI must use the same local Codex configuration.

## Configure

Set `TYPESAFE_API_KEY` in the environment that starts Codex, or create `~/.config/jev-skill-router/config.json`:

```json
{
  "apiKey": "YOUR_TYPESAFE_API_KEY",
  "model": "jev-latest",
  "threshold": 0.8,
  "maxSkills": 3,
  "timeoutMs": 12000,
  "codexBin": "codex"
}
```

Keep this file outside the repository and restrict its permissions:

```sh
chmod 600 ~/.config/jev-skill-router/config.json
```

For the desktop app, prefer the configuration file: apps launched from Finder may not inherit terminal environment variables. The file is optional when the API key is supplied through the environment. An explicitly specified, missing configuration file is an error.

| Setting | Default | Meaning |
| --- | --- | --- |
| `apiKey` | empty | Overridden by `TYPESAFE_API_KEY`. |
| `model` | `jev-latest` | Jev model or versioned Jev identifier. |
| `threshold` | `0.8` | Minimum relevance probability; must be greater than `0.5` and at most `1`. |
| `maxSkills` | `3` | Maximum optional selections, from `1` to `20`. |
| `timeoutMs` | `12000` | Shared discovery/API deadline, from `100` to `20000` milliseconds. |
| `codexBin` | `codex` | Executable name or absolute path; no shell arguments. Overridden by `JEV_CODEX_BIN`. |

Set `JEV_SKILL_ROUTER_CONFIG` to use another configuration file, or `JEV_SKILL_ROUTER_DISABLED=1` to disable routing. The plugin does not write settings or store prompts.

## Behavior

- Queries Codex's effective catalog for the hook's working directory, including enabled plugins. It does not scan old plugin cache versions.
- Excludes disabled, missing, invalid, and explicitly manual-only skills (`policy.allow_implicit_invocation: false` in `agents/openai.yaml`). Resolves symlink aliases so the same file is evaluated once.
- Sends one independent [Noul question](https://docs.typesafe.ai/primitives/noul) per candidate. Noul is a probability of relevance, **not** a separate confidence score. This supports multiple skills and catalogs larger than Choice's 255-option limit.
- Packs all candidates into bounded requests, with at most three concurrent requests. It uses conservative UTF-8 byte limits for Jev's documented token windows, without cutting the candidate list to an arbitrary top K.
- Selects the highest probabilities that meet the threshold. No matching score means no additional optional skills.
- Preserves explicitly requested skills, higher-priority requirements, and skills already needed by an ongoing task. Routing does not authorize tool execution or other actions.
- Missing keys, API errors, rate limits, timeouts, oversized inputs, or invalid responses leave normal Codex selection in place, with a short status message. Failed batches do not produce partial selections. No retries are performed inside the hook's latency budget.

Only the latest submitted prompt is evaluated; previous conversation turns are not read. Very short follow-ups may not provide enough context for additional recommendations. The separate catalog process uses persisted Codex configuration; task-only extra skill roots or unsaved configuration overrides are not inherited.

## Data sent to TypeSafe

The current prompt and candidate names/descriptions are sent to `https://api.typesafe.ai/v1/systemone`. Full skill bodies and conversation transcripts are not read. Catalog path fields remain local. Any sensitive text already present in a prompt or description would still be sent, so enable the hook only for tasks appropriate for your TypeSafe account.

The key is sent only as the API authorization header. Redirects are rejected. Error output does not include keys, prompts, server response bodies, or app-server logs.

## Local development and checks

```sh
git clone git@github.com:droid-Q/jev-skill-router.git
cd jev-skill-router
npm ci
npm run build
npm test
npm run skills
```

`npm run skills` lists eligible candidates and whether a key is configured; it makes **no Jev request**. The source uses native Node.js networking/process APIs and the `yaml` parser for skill policies. `esbuild` produces the committed, standalone plugin script. Rebuild and commit that script whenever the source changes.

To exercise the actual Jev request after configuring a key, from the repository root:

```sh
node -e 'process.stdout.write(JSON.stringify({hook_event_name:"UserPromptSubmit",cwd:process.cwd(),prompt:"Review the JavaScript code and its tests."}))' \
  | node plugins/jev-skill-router/scripts/router.mjs
```

This sends the sample prompt and your eligible skill metadata to TypeSafe. Success returns `hookSpecificOutput.additionalContext`; a fallback returns `systemMessage`. Hooks exit successfully on fallback so the original task can proceed.

The self-check covers the app-server protocol, policy filtering, symlink deduplication, bundled CLI, request shape, multi-skill selection, batching, invalid responses, timeouts, and safe fallback using synthetic Jev responses. It does **not** measure Jev's selection accuracy or prove real API access.

## References

- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Plugin packaging and hook discovery](https://developers.openai.com/plugins/build/plugins)
- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Jev model limits](https://docs.typesafe.ai/models)
