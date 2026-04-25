/**
 * Claude Code provider for relay.
 *
 * Spawns `claude -p --output-format stream-json` and parses the NDJSON
 * event stream, forwarding live tool-call and text updates via onUpdate.
 * Session continuity is achieved by passing `--resume <sessionId>`.
 */

import { spawn } from "node:child_process";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Resume a previous Claude Code session */
  sessionId?: string;
  model?: string;
  allowedTools?: string[];
  cwd?: string;
  signal?: AbortSignal;
  onUpdate?: (text: string, toolCalls: string[]) => void;
}

export interface RunResult {
  output: string;
  turns: number;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  exitCode: number;
  stderr: string;
  isError: boolean;
  stopReason: string;
  sessionId: string;
}

/** A relay provider — one implementation per external CLI agent. */
export interface Provider {
  /** Human-readable label shown in status bar and notifications */
  label: string;
  run(prompt: string, options: RunOptions): Promise<RunResult>;
}

// ─── Internal event shape emitted by `claude --output-format stream-json` ─────

interface ClaudeStreamEvent {
  type: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    model?: string;
    stop_reason?: string | null;
  };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  stop_reason?: string;
  session_id?: string;
}

// ─── Tool-call formatter ───────────────────────────────────────────────────────

function formatToolCall(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? "");
      return `$ ${cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd}`;
    }
    case "Read":      return `read ${input.file_path ?? input.path ?? "?"}`;
    case "Write":     return `write ${input.file_path ?? input.path ?? "?"}`;
    case "Edit":      return `edit ${input.file_path ?? input.path ?? "?"}`;
    case "Grep":      return `grep /${input.pattern ?? "?"}/ in ${input.path ?? "."}`;
    case "Glob":      return `glob ${input.pattern ?? "?"} in ${input.path ?? "."}`;
    case "WebSearch": return `search "${input.query ?? "?"}"`;
    case "WebFetch":  return `fetch ${input.url ?? "?"}`;
    case "TodoWrite": return `todo update`;
    default: {
      const argStr = JSON.stringify(input);
      return `${name} ${argStr.length > 60 ? argStr.slice(0, 60) + "…" : argStr}`;
    }
  }
}

// ─── Claude Code provider ──────────────────────────────────────────────────────

export const claudeProvider: Provider = {
  label: "Claude Code",

  run(prompt, options): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];

      if (options.sessionId)                           args.push("--resume", options.sessionId);
      if (options.model)                               args.push("--model", options.model);
      if (options.allowedTools && options.allowedTools.length > 0) {
        args.push("--allowedTools", ...options.allowedTools);
      }
      args.push(prompt);

      const child = spawn("claude", args, {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      let aborted = false;
      const killChild = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5000);
      };

      if (options.signal) {
        if (options.signal.aborted) killChild();
        else options.signal.addEventListener("abort", killChild, { once: true });
      }

      const result: RunResult = {
        output: "", turns: 0, durationMs: 0, costUsd: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        model: "", exitCode: 0, stderr: "", isError: false, stopReason: "", sessionId: "",
      };

      let currentText = "";
      const toolCalls: string[] = [];
      let stdoutBuf = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: ClaudeStreamEvent;
        try { event = JSON.parse(line); } catch { return; }

        if (event.type === "assistant" && event.message) {
          const msg = event.message;
          if (msg.model) result.model = msg.model;
          if (msg.usage) {
            result.inputTokens   += msg.usage.input_tokens ?? 0;
            result.outputTokens  += msg.usage.output_tokens ?? 0;
            result.cacheReadTokens  += msg.usage.cache_read_input_tokens ?? 0;
            result.cacheWriteTokens += msg.usage.cache_creation_input_tokens ?? 0;
          }
          for (const block of msg.content ?? []) {
            if (block.type === "text" && block.text)       currentText += block.text;
            else if (block.type === "tool_use" && block.name) {
              toolCalls.push(formatToolCall(block.name, block.input as Record<string, unknown>));
            }
          }
          options.onUpdate?.(currentText, [...toolCalls]);
        }

        if (event.type === "result") {
          result.output    = event.result ?? currentText;
          result.turns     = event.num_turns ?? 0;
          result.durationMs = event.duration_ms ?? 0;
          result.costUsd   = event.total_cost_usd ?? 0;
          result.isError   = event.is_error ?? false;
          result.stopReason = event.stop_reason ?? "";
          result.sessionId  = event.session_id ?? "";
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      child.stderr.on("data", (chunk: Buffer) => { result.stderr += chunk.toString(); });

      child.on("close", (code) => {
        if (stdoutBuf.trim()) processLine(stdoutBuf);
        options.signal?.removeEventListener("abort", killChild);
        result.exitCode = code ?? 0;
        if (aborted) reject(new Error("Claude Code was aborted"));
        else resolve(result);
      });

      child.on("error", (err) => {
        options.signal?.removeEventListener("abort", killChild);
        reject(err);
      });
    });
  },
};
