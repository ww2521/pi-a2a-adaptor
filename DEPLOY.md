# Deploy Guide

## Deploy to pi

Copy the **entire project directory** to pi's extensions folder:

```bash
# On the pi host
mkdir -p ~/.pi/agent/extensions/
cp -r /path/to/pi-a2a-adaptor ~/.pi/agent/extensions/
```

Or via SCP from your development machine:

```bash
scp -r pi-a2a-adaptor pi@<pi-host>:~/.pi/agent/extensions/
```

## Final Directory Structure

```
~/.pi/agent/extensions/pi-a2a-adaptor/
├── package.json           ← contains "pi": {"extensions": ["./pi-extension/index.ts"]}
├── src/
│   ├── index.ts           ← library exports
│   ├── client.ts          ← A2AClient core
│   ├── registry.ts        ← AgentRegistry
│   ├── task-manager.ts    ← TaskManager
│   ├── types.ts           ← type definitions
│   └── errors.ts          ← error types
└── pi-extension/
    └── index.ts           ← pi extension entry (commands + tools)
```

**No build step needed.** pi uses [jiti](https://github.com/unjs/jiti) to load TypeScript directly.

## Key package.json Field

```json
{
  "name": "pi-a2a-adaptor",
  "pi": {
    "extensions": ["./pi-extension/index.ts"]
  }
}
```

The `pi.extensions` field tells pi which files are extension entry points.

## Restart pi

```bash
pi restart
# Or hot-reload from within pi
/reload
```

## Verify

```
/a2a-help
/a2a-discover <your-agent-url>
/a2a-send <agent-url> "hello"
```

## Troubleshooting

```bash
# Check extension logs
cat ~/.pi/logs/extensions.log | grep a2a

# Verify directory structure
ls -la ~/.pi/agent/extensions/pi-a2a-adaptor/src/
```

Common issues:
- **Extension not loaded** — check that `package.json` has the correct `pi.extensions` path and that all `.ts` files are present
- **Cannot find module** — verify that `pi-extension/index.ts` imports from `../src/...` correctly
- **Runtime errors** — check `~/.pi/logs/extensions.log` for stack traces
