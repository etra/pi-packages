# relay

A pi package that delegates tasks to external CLI coding agents.

## What it does

Provides two things in one package:

### 1. `/relay` — interactive bridge mode

Routes your messages to an external agent instead of pi's own LLM, with session continuity across turns.

```
/relay claude     — activate Claude Code bridge
/relay off        — return to normal pi model
/relay            — show current status
```

While the bridge is active every message you type is forwarded to Claude Code via `claude -p`. The session ID is tracked across turns so Claude Code maintains its own conversation context.

### 2. `relay_task` tool — LLM-callable sub-agent

Pi's model can call this autonomously to spin up a Claude Code subprocess for a self-contained task and get the result back inline. Useful for heavy multi-file edits, research spikes, or code review without switching apps.

Add guidance to your system prompt or a skill file, e.g.:

> Use `relay_task` when the task requires heavy multi-file editing or you want an isolated context window for a large focused job.

## Why use this instead of switching to Claude directly?

You're mid-session in pi — you have conversation history, git checkpoints, other extensions running. You just want to punch one task out to Claude Code and get the result back without losing that context.

## Installation

You can install this package directly from GitHub:

```bash
pi install git:github.com/etra/pi-packages/relay
```

Or, during development, point pi at the local path in your settings:

```json
{
  "packages": ["/absolute/path/to/pi-packages/relay"]
}
```

## Adding providers

Each provider lives in `providers/`. To add OpenCode (for example):

1. Create `providers/opencode.ts` exporting a `Provider` object.
2. Import it in `extensions/index.ts` and add it to the `PROVIDERS` map.

The `Provider` interface is exported from `providers/claude.ts`:

```ts
export interface Provider {
  label: string;
  run(prompt: string, options: RunOptions): Promise<RunResult>;
}
```
