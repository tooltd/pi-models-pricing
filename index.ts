/**
 * Pi Models Pricing Extension
 *
 * `/model` only lists model names, and `pi --list-models` only shows context
 * size — nothing tells you what a model costs or what it can do. This extension
 * adds `/models`: pick a model from a list that shows price, context window,
 * input modalities and thinking support, sorted from free to most expensive.
 *
 * Commands:
 *   /models              - pick a model (sorted free → most expensive)
 *   /models free         - only free models
 *   /models paid         - only paid models
 *   /models all          - include providers without credentials (marked no-key)
 *   /models <filter>     - filter by name / id / provider
 *   /models <exact id>   - select directly without opening the list
 *
 * Selecting a model:
 *   1. switches the session model (pi.setModel)
 *   2. writes defaultProvider + defaultModel to settings.json, so it becomes
 *      the default model for new sessions
 *   3. asks for a thinking level when the model supports more than one, and
 *      stores it as modelThinkingLevels["provider/id"]
 *
 * The list is a custom component that scrolls inside the terminal height
 * (Pi's ctx.ui.select renders every option and cannot scroll, so a short
 * terminal hides the bottom of the list), with an inline filter and a
 * (n/total) indicator.
 *
 * Prices come from Pi's local catalog cache (ctx.modelRegistry, backed by
 * ~/.pi/agent/models-store.json) — the same rates Pi uses to compute
 * usage.cost. No network calls.
 *
 * Sort order: (input + output) USD per 1M tokens, free models first.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";

/** Make the picked model the default for new sessions (writes settings.json). */
const PERSIST_AS_DEFAULT = true;
/** Ask for a thinking level after picking a model, when it supports several. */
const ASK_THINKING = true;
/** Show price + context whenever the model changes (including Pi's own /model). */
const NOTIFY_ON_SELECT = true;

// ───────────────────────────────── format ─────────────────────────────────

const money = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  const digits = n >= 1 ? 2 : n >= 0.01 ? 3 : 5;
  return `$${n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}`;
};

const tokens = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    // 1048576 and 1000000 both read as "1M": round when off by less than 6%.
    return `${Math.abs(v - Math.round(v)) < 0.06 ? Math.round(v) : +v.toFixed(2)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
};

const moneyPair = (cost: Model<any>["cost"]): string =>
  cost.input + cost.output > 0 ? `${money(cost.input)}/${money(cost.output)}` : "free";

/** Bigger means more expensive; free models are 0. */
const priceKey = (m: Model<any>): number => m.cost.input + m.cost.output;

/** Input capabilities: text → txt, image → img, … */
const modalities = (m: Model<any>): string => {
  const list = (m.input ?? []).map((x) => (x === "text" ? "txt" : x === "image" ? "img" : String(x)));
  return list.length > 0 ? list.join(",") : "-";
};

const truncate = (s: string, width: number): string =>
  s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;

const pad = (s: string, width: number, right = false): string =>
  right ? s.padStart(width) : s.padEnd(width);

const label = (m: Model<any>): string => `${m.provider}/${m.id}`;

const summary = (m: Model<any>, level?: string): string => {
  const c = m.cost;
  const parts = [
    `${m.name || m.id} · ${m.provider}`,
    `in ${money(c.input)} · out ${money(c.output)} / 1M`,
    `cache ${money(c.cacheRead)} read / ${money(c.cacheWrite)} write`,
    `ctx ${tokens(m.contextWindow)} · max out ${tokens(m.maxTokens)}`,
    `input ${modalities(m)}`,
  ];
  if (m.reasoning) parts.push(level ? `thinking ${level}` : "reasoning");
  if (m.cost.tiers?.length) parts.push(`+${m.cost.tiers.length} long-context tier(s)`);
  return parts.join(" · ");
};

// ───────────────────────────────── settings ─────────────────────────────────

type SavedSettings = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  modelThinkingLevels?: Record<string, string>;
  [key: string]: unknown;
};

const settingsFile = (): string => join(getAgentDir(), "settings.json");

function readSettings(): SavedSettings {
  const file = settingsFile();
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf-8")) as SavedSettings;
}

/**
 * Patch a few keys of settings.json. Safe against Pi's own writes: Pi merges
 * the file on disk and only rewrites the fields it marked as modified, so keys
 * written here are preserved.
 */
function patchSettings(patch: Partial<SavedSettings>): void {
  const file = settingsFile();
  const current = readSettings();
  const next: SavedSettings = { ...current, ...patch };
  if (patch.modelThinkingLevels) {
    next.modelThinkingLevels = { ...(current.modelThinkingLevels ?? {}), ...patch.modelThinkingLevels };
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  renameSync(tmp, file);
}

// ────────────────────────────── scrollable picker ──────────────────────────────

export type PickItem = { label: string; search: string };

/**
 * Pick one row from a potentially long list.
 *
 * Pi's `ctx.ui.select()` renders every option without a viewport, so on a short
 * terminal the bottom of the list is hidden and moving down never scrolls it.
 * This component keeps the window inside `tui.terminal.rows` and scrolls with
 * the selection, with an inline filter box.
 */
async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  items: PickItem[],
  preselected = 0,
): Promise<PickItem | undefined> {
  if (items.length === 0) return undefined;
  if (!ctx.hasUI) return undefined;

  // Non-TUI modes (rpc/print/json): fall back to Pi's own dialog.
  if (ctx.mode !== "tui") {
    const chosen = await ctx.ui.select(title, items.map((i) => i.label));
    return items.find((i) => i.label === chosen);
  }

  return ctx.ui.custom<PickItem | undefined>((tui, theme, keybindings, done) => {
    const input = new Input({ placeholder: "filter…", placeholderStyle: (t) => theme.fg("dim", t) });
    input.focused = true;

    let filtered = items.map((item, index) => ({ item, index }));
    let sel = Math.max(0, Math.min(preselected, filtered.length - 1));

    const refilter = () => {
      const q = input.getValue().trim().toLowerCase();
      filtered = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !q || item.search.includes(q));
      sel = 0;
    };

    // Leave room for Pi's header/footer around the dialog area.
    const totalLines = () => Math.max(9, (tui.terminal.rows || 24) - 8);

    return {
      render(width: number): string[] {
        // 6 fixed lines: border, title, filter, (n/total), hint, border.
        const visible = Math.max(3, Math.min(Math.max(filtered.length, 1), totalLines() - 6));
        const start = Math.max(
          0,
          Math.min(sel - Math.floor(visible / 2), filtered.length - visible),
        );
        const end = Math.min(start + visible, filtered.length);

        const lines: string[] = [];
        lines.push(theme.fg("dim", "─".repeat(width)));
        lines.push(truncateToWidth(theme.fg("accent", theme.bold(title)), width));
        lines.push(...input.render(width));

        if (filtered.length === 0) {
          lines.push(theme.fg("muted", "  no matching model"));
        } else {
          for (let i = start; i < end; i++) {
            const entry = filtered[i];
            if (!entry) continue;
            const text = truncateToWidth(`${i === sel ? "→" : " "} ${entry.item.label}`, width);
            lines.push(i === sel ? theme.fg("accent", text) : text);
          }
        }

        lines.push(
          theme.fg(
            "muted",
            `  ${filtered.length === 0 ? 0 : sel + 1}/${filtered.length}${filtered.length > visible ? " · ↕ scroll" : ""}`,
          ),
        );
        lines.push(theme.fg("dim", "  ↑↓ move · type to filter · Enter select · Esc cancel"));
        lines.push(theme.fg("dim", "─".repeat(width)));
        return lines;
      },
      handleInput(data: string): void {
        if (filtered.length > 0 && keybindings.matches(data, "tui.select.up")) {
          sel = sel === 0 ? filtered.length - 1 : sel - 1;
        } else if (filtered.length > 0 && keybindings.matches(data, "tui.select.down")) {
          sel = sel === filtered.length - 1 ? 0 : sel + 1;
        } else if (filtered.length > 0 && keybindings.matches(data, "tui.select.confirm")) {
          done(filtered[sel]?.item);
          return;
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          if (input.getValue() !== "") {
            input.setValue("");
            refilter();
          } else {
            done(undefined);
            return;
          }
        } else {
          const before = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== before) refilter();
        }
        tui.requestRender();
      },
      invalidate(): void {
        input.invalidate?.();
      },
    };
  });
}

// ───────────────────────────────── list rows ─────────────────────────────────

type Entry = PickItem & { model: Model<any> };

function buildEntries(
  models: Model<any>[],
  current: Model<any> | undefined,
  hasAuth: (m: Model<any>) => boolean,
): Entry[] {
  const sorted = [...models].sort((a, b) => {
    const d = priceKey(a) - priceKey(b);
    if (d !== 0) return d;
    const c = (b.contextWindow || 0) - (a.contextWindow || 0);
    if (c !== 0) return c;
    return label(a).localeCompare(label(b));
  });

  const nameW = Math.min(30, sorted.reduce((w, m) => Math.max(w, (m.name || m.id).length), 0));
  const priceW = sorted.reduce((w, m) => Math.max(w, moneyPair(m.cost).length), "price".length);
  const ctxW = sorted.reduce((w, m) => Math.max(w, tokens(m.contextWindow).length), 3);
  const modW = sorted.reduce((w, m) => Math.max(w, modalities(m).length), "input".length);

  return sorted.map((m) => {
    const isCurrent = current !== undefined && m.provider === current.provider && m.id === current.id;
    const flags = [hasAuth(m) ? "" : "no-key", m.cost.tiers?.length ? "tiered" : ""]
      .filter(Boolean)
      .join(" ");
    const row = [
      `${isCurrent ? "●" : " "} ${pad(truncate(m.name || m.id, nameW), nameW)}`,
      pad(moneyPair(m.cost), priceW, true),
      pad(tokens(m.contextWindow), ctxW, true),
      pad(modalities(m), modW),
      pad(m.reasoning ? "think" : "-", 5),
      m.provider,
      flags,
    ]
      .filter((part) => part !== "")
      .join("  ");
    return { label: row, search: `${label(m)} ${m.name ?? ""}`.toLowerCase(), model: m };
  });
}

// ───────────────────────────────── extension ─────────────────────────────────

export default function (pi: ExtensionAPI) {
  let suppress = false;

  pi.registerCommand("models", {
    description: "Pick a model with price/context/input/thinking, sorted free → expensive, and make it the default",
    handler: async (args, ctx) => {
      const registry = ctx.modelRegistry;
      const query = (args ?? "").trim().toLowerCase();
      const wantAll = query === "all";
      const wantFree = query === "free";
      const wantPaid = query === "paid";
      const text = wantAll || wantFree || wantPaid ? "" : query;

      const hasAuth = (m: Model<any>): boolean => {
        try {
          return registry.hasConfiguredAuth(m);
        } catch {
          return true;
        }
      };

      const all = registry.getAll();
      let models = wantAll ? all : all.filter(hasAuth);
      if (wantFree) models = models.filter((m) => priceKey(m) === 0);
      if (wantPaid) models = models.filter((m) => priceKey(m) > 0);
      if (text) {
        models = models.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(text));
      }

      if (models.length === 0) {
        const anywhere = all.filter((m) =>
          text ? `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(text) : true,
        );
        ctx.ui.notify(
          !wantAll && anywhere.length > 0
            ? `${anywhere.length} model(s) match, but the provider has no credentials (try /models all)`
            : `No model matches "${args ?? ""}". Try /models all.`,
          "warning",
        );
        return;
      }

      const entries = buildEntries(models, ctx.model, hasAuth);

      // A single hit, or an exact id/name, selects directly without a dialog.
      const exact = models.find(
        (m) => m.id.toLowerCase() === text || (m.name || "").toLowerCase() === text,
      );

      let picked: Model<any> | undefined;
      if (exact) {
        picked = exact;
      } else if (!ctx.hasUI) {
        ctx.ui.notify(entries.map((e) => e.label).join("\n"), "info");
        return;
      } else {
        const currentIndex = entries.findIndex(
          (e) => ctx.model && e.model.provider === ctx.model.provider && e.model.id === ctx.model.id,
        );
        const title = `Model · free → expensive by (in+out) $/1M · ${models.length} models · ● = current`;
        const choice = await pickFromList(ctx, title, entries, Math.max(0, currentIndex));
        if (!choice) return;
        picked = (choice as Entry).model;
      }
      if (!picked) return;

      let ok = false;
      suppress = true;
      try {
        ok = await pi.setModel(picked);
      } finally {
        suppress = false;
      }
      if (!ok) {
        ctx.ui.notify(`${label(picked)}: no credentials for this provider`, "warning");
        return;
      }

      // ── thinking level ──────────────────────────────────────────────
      // `getSupportedThinkingLevels` is narrower than `ThinkingLevel`; compare
      // through strings so a level stored in settings can be checked too.
      const levels: readonly string[] = getSupportedThinkingLevels(picked);
      let level: string | undefined;
      let persistLevel = false;
      if (levels.length > 1) {
        let saved: string | undefined;
        try {
          saved = readSettings().modelThinkingLevels?.[label(picked)];
        } catch {
          saved = undefined;
        }
        const currentLevel = pi.getThinkingLevel();
        if (ASK_THINKING && ctx.hasUI) {
          const options = levels.map((l) => ({
            label: `${l === currentLevel ? "●" : " "} ${l}${l === saved ? "  (saved)" : ""}`,
            search: l,
          }));
          const choice = await pickFromList(
            ctx,
            `Thinking for ${picked.name || picked.id} · ${picked.provider} · current: ${currentLevel}`,
            options,
            Math.max(0, levels.indexOf(currentLevel)),
          );
          if (choice !== undefined && levels.includes(choice.search)) {
            level = choice.search;
            persistLevel = true;
          }
        }
        if (level === undefined) level = saved ?? currentLevel;
        if (level !== undefined && levels.includes(level)) pi.setThinkingLevel(level as ThinkingLevel);
      } else if (picked.reasoning) {
        // Single supported level (e.g. Kimi K3 → "max"): Pi already applied it.
        level = levels[0] ?? pi.getThinkingLevel();
      }

      // ── persist as default ──────────────────────────────────────────
      let savedNote = "";
      if (PERSIST_AS_DEFAULT) {
        try {
          patchSettings({
            defaultProvider: picked.provider,
            defaultModel: picked.id,
            ...(persistLevel && level ? { modelThinkingLevels: { [label(picked)]: level } } : {}),
          });
          savedNote = " · saved as default";
        } catch (error) {
          savedNote = ` · could not save default: ${(error as Error).message}`;
        }
      }

      ctx.ui.notify(summary(picked, level) + savedNote, "info");
    },
  });

  pi.on("model_select", (event, ctx) => {
    if (!NOTIFY_ON_SELECT || suppress || !ctx.hasUI) return;
    ctx.ui.notify(summary(event.model, pi.getThinkingLevel()), "info");
  });
}
