# pi-a2a-adaptor

> A2A protocol client for [pi coding agent](https://pi.dev) — fully compatible with [fasta2a](https://github.com/datalayer/fasta2a) and the [A2A Protocol](https://a2a-protocol.org).

## Overview

**pi-a2a-adaptor** enables [pi coding agent](https://pi.dev) to discover, communicate with, and orchestrate other A2A-compliant agents. It provides a full A2A client implementation that strictly follows the A2A protocol wire format (tested against fasta2a v0.6.1).

Inspired by [pi-a2a-communication](https://github.com/DrOlu/pi-a2a-communication), this project is a ground-up rewrite that strictly implements the latest A2A protocol specification, making it fully compatible with [fasta2a](https://github.com/datalayer/fasta2a) and other A2A-compliant servers.

## Features

- **Agent Discovery** — Auto-discover remote agents via `/.well-known/agent-card.json`
- **Task Management** — Send tasks, poll status, cancel, and list remote tasks
- **Streaming** — SSE-based real-time task progress via `message/stream`
- **Task Orchestration** — Chain and parallel task execution with artifact passing
- **Long-running Tasks** — Configurable polling with timeout for tasks that take minutes
- **Push Notifications** — Register callback URLs for async task completion
- **13 Commands** — Full CLI interface via `/a2a-*` commands
- **2 Tools** — LLM-callable tools for single and parallel agent calls

## Quick Start

### Install

```bash
pi install npm:pi-a2a-adaptor
```

No build step required. Pi uses [jiti](https://github.com/unjs/jiti) to load TypeScript directly.

### Reload Pi

```
/reload
```

### Discover an Agent

```
/a2a-discover https://your-agent.example.com
```

### Send a Task

```
/a2a-send https://your-agent.example.com "Analyze this code for bugs"
```

### Broadcast to Multiple Agents

```
/a2a-broadcast "Review this code for security issues" --agents https://agent1.com,https://agent2.com
```

### Chain Tasks (Pipeline)

```
/a2a-chain scout "Find bugs in main.py" | worker "Fix {previous}"
```

### Send Task Async (Non-blocking)

```
/a2a-send-async https://your-agent.example.com "Run a long analysis"
/a2a-pending
```

## Commands

| Command | Description |
|---|---|
| `/a2a-discover <url>` | Discover an A2A agent at a URL |
| `/a2a-agents` | List all discovered agents |
| `/a2a-send <agent> <message>` | Send a task — `<agent>` can be name, URL, or list number (waits for result) |
| `/a2a-send-async <agent> <msg>` | Send a task asynchronously (returns immediately, notifies on completion) |
| `/a2a-pending` | List pending async tasks |
| `/a2a-broadcast <msg> --agents <urls>` | Broadcast to multiple agents in parallel |
| `/a2a-chain <agent1> <task1> \| <agent2> <task2>` | Chain tasks sequentially (`{previous}` placeholder) |
| `/a2a-status <task-id> <agent-url>` | Get task status |
| `/a2a-cancel <task-id> <agent-url>` | Cancel a task |
| `/a2a-list <agent-url> [context-id]` | List tasks on a remote agent |
| `/a2a-resubscribe <task-id> <agent-url>` | Resubscribe to a task's event stream |
| `/a2a-config <key> <value>` | Configure timeout, retries, cache TTL, auth, etc. |
| `/a2a-help` | Show help |

## LLM Tools

- **`a2a_call`** — Call a single A2A agent with a task message
- **`a2a_parallel`** — Call multiple A2A agents in parallel with the same message

## Protocol Compliance

This client implements the A2A protocol wire format as used by [fasta2a v0.6.1](https://github.com/datalayer/fasta2a):

| Feature | Implementation |
|---|---|
| JSON-RPC methods | `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/list`, `tasks/resubscribe`, `tasks/pushNotification/*` |
| Dispatch endpoint | `POST /` (unified JSON-RPC) |
| Agent Card | `GET /.well-known/agent-card.json` |
| Part types | discriminated union via `kind` (`"text"`, `"file"`, `"data"`) |
| SSE events | JSON-RPC envelope with `result.kind` (`"task"`, `"status-update"`, `"artifact-update"`) |
| Task states | `submitted`, `working`, `inputRequired`, `completed`, `failed`, `canceled`, `rejected` |

## Project Structure

```
pi-a2a-adaptor/
├── src/
│   ├── client.ts          # A2AClient core (HTTP, SSE, polling)
│   ├── registry.ts        # AgentRegistry with TTL caching
│   ├── task-manager.ts    # TaskManager (chain / parallel)
│   ├── types.ts           # Full A2A type definitions
│   └── errors.ts          # Semantic error types
├── pi-extension/
│   └── index.ts           # pi extension entry (commands + tools)
└── tests/
    ├── a2a-client.test.ts        # 60 protocol-level tests
    ├── a2a-extension.test.ts     # 12 extension/command tests
    ├── a2a-multi-shape.test.ts   # 8 multi-shape response tests
    └── strict-server/
        └── strict_server.py      # 3-port schema-strict mock server
```

## Testing

```bash
npm install
npx vitest run
```

The test suite runs **80 tests across 3 test files** against a schema-strict mock server that implements the fasta2a wire format, covering:

- Agent Card discovery
- `message/send` (sync and async with polling)
- `message/stream` (SSE event parsing)
- `tasks/get`, `tasks/cancel`, `tasks/list`
- `tasks/resubscribe`
- Push notification lifecycle (set / get / list / delete)
- Part types (text, file-bytes, file-uri, data)
- Long-running task polling with timeout
- Error code handling
- **Multi-shape response handling** (wrapped, direct-task, direct-message)
- **Extension command patterns** (send-async, chain, parallel, text extraction)

## Configuration

Edit `~/.pi/agent/settings.json` or use `/a2a-config` at runtime:

```bash
/a2a-config timeout 60000
/a2a-config retryAttempts 3
/a2a-config cacheTtl 300000
/a2a-config verifySsl true

# Bearer Token auth
/a2a-config defaultScheme bearer
/a2a-config bearerToken "your-token-here"

# API Key auth
/a2a-config defaultScheme apiKey
/a2a-config apiKey "your-api-key"

# Disable auth
/a2a-config defaultScheme none
```

## Development

```bash
# Type check
npx tsc --noEmit

# Run tests
npx vitest run

# Run tests in watch mode
npx vitest
```

## License

MIT
