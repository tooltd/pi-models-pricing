# pi-models-pricing

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that makes `/models` tell you what a model **costs**,
how much **context** it has, what **input** it accepts, and which **thinking** levels it supports — sorted from **free to
most expensive**. Picking a model also makes it your **default**.

| Pi already has | Shows | Missing |
|---|---|---|
| `/model` (built-in) | model names | price, context, input, thinking |
| `pi --list-models` | provider, model, context, max-out, thinking, images | **price** |

`/model` is a built-in command, so an extension cannot override it. This extension adds `/models` (plural) instead: the
same "pick a model" flow, with prices — plus a `model_select` hook so the price is reported whenever the model changes,
including through Pi's own `/model`.

## Features

- **Price per model** — input/output USD per 1M tokens, from Pi's local catalog cache.
- **Sorted free → expensive** by `cost.input + cost.output`; free models first.
- **Context window** and **input modalities** (`txt`, `img`) in every row.
- **Thinking support** in the list, and a thinking-level picker after selecting a model that supports several levels.
- **Default model**: the picked model is written to `settings.json`, so new sessions start with it.
- **Scrollable list**: fits any terminal height (Pi's `ctx.ui.select` renders every option and cannot scroll).
- **Inline filter**: type to narrow the list by name, id or provider.
- **Offline**: reads `~/.pi/agent/models-store.json` through `ctx.modelRegistry` — no network requests.

## Install

```bash
# git source (recommended)
pi install git:github.com/tooltd/pi-models-pricing

# or try it for one session
pi -e git:github.com/tooltd/pi-models-pricing

# or from a local checkout
pi install ./pi-models-pricing
```

Restart Pi (or run `/reload`) after installing.

## Usage

```
/models              # all models from configured providers, sorted free → expensive
/models free         # only free models
/models paid         # only paid models
/models all          # include providers without credentials (marked no-key)
/models kimi         # filter by name / id / provider
/models glm-5.3      # exact id or name → select immediately, no dialog
```

### The list

```
────────────────────────────────────────────────────────────────────────
Model · free → expensive by (in+out) $/1M · 29 models · ● = current
> filter…
→● Beam Free                           free    1M  txt      think  opencode-go
    Muse Spark 1.2 Contributor     $0.1/$0.2    1M  txt,img  think  opencode-go
    GPT-6 Luna                     $0.1/$0.5    1M  txt,img  think  opencode-go  tiered
  3/29 · ↕ scroll
  ↑↓ move · type to filter · Enter select · Esc cancel
────────────────────────────────────────────────────────────────────────
```

| Column | Meaning |
|---|---|
| `●` | the model currently in use |
| price | `input/output` USD per 1M tokens; `free` when both are 0 |
| context | context window (`1M` ≈ 1048576 or 1000000, `256K`, …) |
| input | accepted input modalities: `txt`, `img` (combined as `txt,img`) |
| thinking | `think` when the model supports reasoning, `-` when it does not |
| provider | provider id |
| `tiered` | long-context pricing tiers (`cost.tiers`) present |
| `no-key` | provider has no credentials (only with `/models all`) |

Keys: `↑`/`↓` move, type to filter, `Enter` select, `Esc` clear the filter first, then cancel.

### After selecting a model

1. **Switch the session model** (`pi.setModel`).
2. **Make it the default**: writes `defaultProvider` + `defaultModel` to `~/.pi/agent/settings.json`, so every new
   session starts with it. Disable with `PERSIST_AS_DEFAULT = false`.
3. **Ask for a thinking level** when the model supports more than one. Levels come from
   `getSupportedThinkingLevels(model)` (it reads `thinkingLevelMap`: `null` means unsupported, `xhigh`/`max` only when
   mapped). The dialog marks the current level with `●` and a previously stored one with `(saved)`. Choosing writes
   `modelThinkingLevels["provider/id"]` — the same key Pi's own `/thinking` uses. Models with a single level (e.g.
   Kimi K3 → only `max`) are applied by Pi automatically and are not prompted.

A toast then reports the full picture:

```
DeepSeek V4.1 Flash · opencode-go · in $0.15 · out $0.6 / 1M · cache $0.003 read / $0 write
· ctx 1M · max out 384K · input txt,img · thinking high · saved as default
```

## How the default is saved

Writing settings from an extension is a patch, not a rewrite:

1. read `~/.pi/agent/settings.json` (path from `getAgentDir()`, honours `PI_CODING_AGENT_DIR`);
2. replace `defaultProvider` / `defaultModel` / merge `modelThinkingLevels`;
3. write a temp file, then rename (atomic).

Pi's settings manager merges the file on disk and only rewrites the fields it marked as modified, so keys written here
are not clobbered by later Pi settings changes. A project-level `.pi/settings.json` with its own `defaultModel` still
wins inside that project.

## Configuration

Constants at the top of `index.ts`:

| Constant | Default | Purpose |
|---|---|---|
| `PERSIST_AS_DEFAULT` | `true` | Write the picked model as the global default |
| `ASK_THINKING` | `true` | Ask for a thinking level after picking a model |
| `NOTIFY_ON_SELECT` | `true` | Report price whenever the model changes |

## Notes

- `cost.tiers` (long-context pricing) is not used for ordering; those models get a `tiered` badge.
- Prices come from the cached catalog (`~/.pi/agent/models-store.json`). To refresh, let Pi update its catalog or delete
  the file and restart Pi.
- The extension only reads the model registry and calls `setModel` / `setThinkingLevel`; it never touches session usage.

## Development

Load a local file directly while iterating:

```bash
pi -e ./index.ts
```

Type-check against a Pi install (the host packages are peer dependencies, not bundled):

```jsonc
// tsconfig.check.json
{
  "compilerOptions": {
    "noEmit": true,
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"],
    "paths": {
      "@earendil-works/pi-coding-agent": ["<pi-install>/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
      "@earendil-works/pi-ai": ["<pi-install>/node_modules/@earendil-works/pi-ai/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["<pi-install>/node_modules/@earendil-works/pi-tui/dist/index.d.ts"]
    }
  },
  "files": ["index.ts"]
}
```
