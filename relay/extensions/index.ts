/**
 * relay — delegate tasks to external CLI coding agents
 *
 * Provides two things:
 *
 *   1. /relay command — interactive bridge mode.
 *      All your messages are routed to the chosen provider instead of pi's
 *      own LLM, with session continuity across turns.
 *
 *        /relay claude     — activate Claude Code bridge
 *        /relay off        — return to normal pi model
 *        /relay            — show current status
 *
 *   2. relay_task tool — LLM-callable sub-agent.
 *      Pi's model can call this autonomously to delegate a self-contained
 *      task to Claude Code in an isolated subprocess and get the result back.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { claudeProvider } from "../providers/claude.js";
import type { Provider, RunResult } from "../providers/claude.js";

// ─── Provider registry ────────────────────────────────────────────────────────
// Add new providers here as they are implemented.

const PROVIDERS: Record<string, Provider> = {
  claude: claudeProvider,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n < 1000)      return String(n);
  if (n < 10_000)    return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatStats(r: RunResult): string {
  const parts: string[] = [];
  if (r.turns)            parts.push(`${r.turns} turn${r.turns !== 1 ? "s" : ""}`);
  if (r.inputTokens)      parts.push(`↑${fmtK(r.inputTokens)}`);
  if (r.outputTokens)     parts.push(`↓${fmtK(r.outputTokens)}`);
  if (r.cacheReadTokens)  parts.push(`R${fmtK(r.cacheReadTokens)}`);
  if (r.cacheWriteTokens) parts.push(`W${fmtK(r.cacheWriteTokens)}`);
  if (r.costUsd)          parts.push(`$${r.costUsd.toFixed(4)}`);
  if (r.durationMs)       parts.push(`${(r.durationMs / 1000).toFixed(1)}s`);
  if (r.model)            parts.push(r.model.replace(/\[.*\]$/, ""));
  return parts.join(" ");
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── Bridge state ────────────────────────────────────────────────────────────
  let activeProviderKey: string | null = null;
  let bridgeSessionId: string | null = null;

  function getActiveProvider(): Provider | null {
    return activeProviderKey ? (PROVIDERS[activeProviderKey] ?? null) : null;
  }

  // ── Input interception ──────────────────────────────────────────────────────
  // When a bridge is active, every user message is forwarded to the provider
  // instead of pi's own LLM.
  pi.on("input", async (event, ctx) => {
    const provider = getActiveProvider();
    if (!provider) return { action: "continue" };

    // Let pi's own /commands through so you can still do /relay off, etc.
    if (event.text.startsWith("/")) return { action: "continue" };

    const prompt = event.text.trim();
    if (!prompt) return { action: "continue" };

    ctx.ui.setStatus("relay", `⚡ ${provider.label} running…`);

    try {
      let liveToolCalls: string[] = [];

      const result = await provider.run(prompt, {
        sessionId: bridgeSessionId ?? undefined,
        cwd: ctx.cwd,
        signal: ctx.signal,
        onUpdate: (_text, toolCalls) => {
          liveToolCalls = toolCalls;
          const lastTool = toolCalls.at(-1);
          const preview = lastTool
            ? (lastTool.length > 45 ? lastTool.slice(0, 45) + "…" : lastTool)
            : "";
          ctx.ui.setStatus("relay", `⚡ ${provider.label}: ${preview || "thinking…"}`);
        },
      });

      if (result.sessionId) bridgeSessionId = result.sessionId;

      const label = PROVIDERS[activeProviderKey!]?.label ?? activeProviderKey!;
      const sessionHint = bridgeSessionId
        ? `session:${bridgeSessionId.slice(0, 8)}`
        : "new session";
      ctx.ui.setStatus("relay", `⚡ relay:${label} (${sessionHint})`);

      const stats = formatStats(result);
      const toolSection =
        liveToolCalls.length > 0
          ? `\n\n**Tools used:**\n${liveToolCalls.map((t) => `- \`${t}\``).join("\n")}`
          : "";
      const statsSection = stats ? `\n\n_${stats}_` : "";
      const body =
        `**${provider.label}:**\n\n${result.output || "(no output)"}` +
        toolSection +
        statsSection;

      if (result.exitCode === 0 && !result.isError) {
        pi.sendMessage(
          {
            customType: "relay-result",
            content: body,
            display: true,
            details: { exitCode: result.exitCode, stopReason: result.stopReason, stats },
          },
          { triggerTurn: false },
        );
      } else {
        ctx.ui.notify(`❌ ${provider.label} exited with code ${result.exitCode}`, "error");
        pi.sendMessage(
          {
            customType: "relay-error",
            content: `**${provider.label} error (exit ${result.exitCode}):**\n\n${result.output || result.stderr || "(no output)"}`,
            display: true,
            details: { exitCode: result.exitCode, stopReason: result.stopReason },
          },
          { triggerTurn: false },
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.setStatus("relay", "");
      ctx.ui.notify(`❌ Relay error: ${msg}`, "error");
    }

    return { action: "handled" };
  });

  // ── /relay command ──────────────────────────────────────────────────────────
  pi.registerCommand("relay", {
    description: "Control the relay bridge. Usage: /relay [claude|off]",

    getArgumentCompletions: (prefix: string) => {
      const choices = ["off", ...Object.keys(PROVIDERS)];
      return choices
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ value: c, label: c }));
    },

    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      // No argument → show status
      if (!arg) {
        if (activeProviderKey) {
          const label = PROVIDERS[activeProviderKey]?.label ?? activeProviderKey;
          const sessionLine = bridgeSessionId
            ? `Session ID: \`${bridgeSessionId}\``
            : "No session yet (first message will start one)";
          ctx.ui.notify(`⚡ Relay ACTIVE — provider: ${label}\n${sessionLine}`, "info");
        } else {
          const available = Object.keys(PROVIDERS).join(", ");
          ctx.ui.notify(
            `Relay is OFF. Available providers: ${available}\nUsage: /relay <provider>`,
            "info",
          );
        }
        return;
      }

      // /relay off
      if (arg === "off") {
        if (!activeProviderKey) {
          ctx.ui.notify("Relay is already off.", "info");
          return;
        }
        const label = PROVIDERS[activeProviderKey]?.label ?? activeProviderKey;
        activeProviderKey = null;
        bridgeSessionId = null;
        ctx.ui.setStatus("relay", "");
        ctx.ui.notify(`Relay deactivated (was: ${label}).`, "info");
        return;
      }

      // /relay <provider>
      if (!PROVIDERS[arg]) {
        const available = Object.keys(PROVIDERS).join(", ");
        ctx.ui.notify(`Unknown provider "${arg}". Available: ${available}`, "error");
        return;
      }

      const switching = activeProviderKey && activeProviderKey !== arg;
      activeProviderKey = arg;
      if (switching) bridgeSessionId = null;

      const label = PROVIDERS[activeProviderKey].label;
      const sessionHint = bridgeSessionId
        ? `resuming session ${bridgeSessionId.slice(0, 8)}`
        : "starting new session";
      ctx.ui.notify(
        `⚡ Relay activated: ${label} (${sessionHint})\nYour messages will now go to ${label}. Use /relay off to return to normal.`,
        "success",
      );
      ctx.ui.setStatus("relay", `⚡ relay:${label} (new session)`);
    },
  });

  // ── relay_task tool ─────────────────────────────────────────────────────────
  // Pi's LLM can call this to delegate a self-contained task to Claude Code.
  // Describe *when* to use it in your system prompt / skill, e.g.:
  //   "Use relay_task when a task requires heavy multi-file editing or you
  //    want an isolated context window for a large focused job."
  pi.registerTool({
    name: "relay_task",
    label: "Relay Task",
    description: [
      "Delegate a task to Claude Code running as a background subprocess.",
      "Claude Code has its own full toolset (Bash, Read, Write, Edit, Grep, WebSearch, etc.).",
      "Use this when you want a separate Claude Code instance to handle a self-contained",
      "task in an isolated context window — e.g. a large refactor, a research spike, or",
      "code review — and get the result back here.",
      "Returns the final answer plus a log of tool calls Claude Code made.",
    ].join(" "),
    parameters: Type.Object({
      task: Type.String({
        description: "The task or prompt to send to Claude Code. Be specific and self-contained.",
      }),
      model: Type.Optional(
        Type.String({
          description: 'Claude model to use (e.g. "sonnet", "haiku", "opus"). Defaults to Claude Code\'s configured model.',
        }),
      ),
      allowedTools: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Restrict which tools Claude Code may use (e.g. ["Read", "Grep", "Glob"] for read-only). Omit to allow all.',
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "🤖 Spawning Claude Code…" }],
        details: { toolCalls: [] as string[], stats: "" },
      });

      try {
        const result = await claudeProvider.run(params.task, {
          model: params.model,
          allowedTools: params.allowedTools,
          cwd: ctx.cwd,
          signal,
          onUpdate: (text, toolCalls) => {
            onUpdate?.({
              content: [{ type: "text", text: text || "(thinking…)" }],
              details: { toolCalls, stats: "" },
            });
          },
        });

        const stats = formatStats(result);
        const errorNote  = result.isError ? "\n\n⚠️ Claude Code reported an error." : "";
        const stderrNote =
          result.stderr && result.exitCode !== 0
            ? `\n\n⚠️ stderr:\n${result.stderr.slice(0, 500)}`
            : "";

        return {
          content: [{ type: "text", text: (result.output || "(no output)") + errorNote + stderrNote }],
          isError: result.isError || result.exitCode !== 0,
          details: { toolCalls: [], stats, exitCode: result.exitCode, stopReason: result.stopReason },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ Failed to run Claude Code: ${msg}` }],
          isError: true,
          details: { toolCalls: [], stats: "", exitCode: -1, stopReason: "error" },
        };
      }
    },
  });

  // ── Session start notification ───────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    if (activeProviderKey) {
      const label = PROVIDERS[activeProviderKey]?.label ?? activeProviderKey;
      ctx.ui.setStatus("relay", `⚡ relay:${label} (new session)`);
      ctx.ui.notify(`relay ready — bridge is ACTIVE (${label})`, "info");
    } else {
      ctx.ui.notify(
        "relay ready — use /relay claude to activate",
        "info",
      );
    }
  });
}
