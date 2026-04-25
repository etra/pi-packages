# pi-packages

A collection of custom packages and extensions for [pi](https://github.com/mariozechner/pi-coding-agent).

## Installation

You can install packages directly from this repository using `pi install`:

```bash
pi install git:github.com/etra/pi-packages
```

This will install the entire collection. You can then use `pi config` (or edit your `.pi/settings.json`) to toggle individual plugins on or off.

| Package | Description |
|---|---|
| [**relay**](./packages/relay) | Delegate tasks to external CLI coding agents (Claude Code, OpenCode) from within pi without losing your session context. Provides `/relay` interactive bridge mode and the `relay_task` sub-agent tool. |

---

## Creating a new package

To create a new package in this repository:

1. Create a new folder in `packages/` (e.g. `packages/my-package/`).
2. Add a `package.json` with the `"pi"` manifest keyword:
   ```json
   {
     "name": "@pi-packages/my-package",
     "version": "0.1.0",
     "keywords": ["pi-package"],
     "pi": {
       "extensions": ["./extensions"]
     },
     "peerDependencies": {
       "@mariozechner/pi-coding-agent": "*",
       "typebox": "*"
     }
   }
   ```
3. Create your `extensions/index.ts` file.
4. Test it locally via: `pi install /absolute/path/to/pi-packages/my-package`
