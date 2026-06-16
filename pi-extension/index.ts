/**
 * pi-a2a-adaptor pi-extension
 *
 * pi coding agent 扩展入口 — 注册 /a2a-* 命令和工具
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { A2AClient } from "../src/client.js";
import { A2AError } from "../src/errors.js";
import { AgentRegistry } from "../src/registry.js";
import { TaskManager } from "../src/task-manager.js";
import type { A2AConfig, RemoteAgent, TaskOptions } from "../src/types.js";

// ─── Global State ───

let a2aClient: A2AClient | null = null;
let registry: AgentRegistry | null = null;
let taskManager: TaskManager | null = null;
let config: A2AConfig | null = null;

// ─── Async Task Tracking ───

interface PendingTask {
  id: string;
  agentUrl: string;
  agentName: string;
  message: string;
  submittedAt: number;
  pollingInterval: ReturnType<typeof setInterval> | null;
}

const pendingTasks = new Map<string, PendingTask>();

// ─── Default Config ───

const DEFAULT_CONFIG: A2AConfig = {
  client: {
    timeout: 30000,
    retryAttempts: 3,
    retryDelay: 1000,
    maxConcurrentTasks: 10,
    streamingEnabled: true,
  },
  server: {
    enabled: false,
    port: 10000,
    host: "0.0.0.0",
    basePath: "/a2a",
  },
  discovery: {
    cacheEnabled: true,
    cacheTtl: 300000,
    agentCardPath: "/.well-known/agent-card.json",
  },
  security: {
    defaultScheme: "none",
    verifySsl: true,
  },
};

// ─── Helpers ───

function resolveAgent(ref: string): RemoteAgent {
  // 1. Try by index (1-based from /a2a-agents output)
  const idx = parseInt(ref, 10);
  if (!isNaN(idx) && idx > 0) {
    const agents = registry!.list();
    if (idx <= agents.length) return agents[idx - 1];
  }

  // 2. Try by name
  const found = registry!.lookup(ref);
  if (found) return found;

  // 3. Treat as URL
  return {
    name: ref,
    description: "",
    url: ref,
    version: "1.0.0",
    capabilities: {},
    skills: [],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    discoveredAt: Date.now(),
  };
}

function extractTextFromResult(task: any): string {
  if (task.artifacts && task.artifacts.length > 0) {
    return task.artifacts[0].parts
      .filter((p: any) => p.kind === "text" && p.text)
      .map((p: any) => p.text)
      .join("\n");
  }
  if (task.status?.message?.parts) {
    return task.status.message.parts
      .filter((p: any) => p.kind === "text" && p.text)
      .map((p: any) => p.text)
      .join("\n");
  }
  return `Task ${task.id}: ${task.status?.state}`;
}

// ─── Extension Entry ───

export default function (pi: ExtensionAPI) {
  // ─── Session Lifecycle ───

  pi.on("session_start", async (_event, ctx) => {
    config = DEFAULT_CONFIG;
    a2aClient = new A2AClient(config.client, config.security);
    registry = new AgentRegistry(config.discovery.cacheTtl);
    taskManager = new TaskManager(a2aClient, registry);
    ctx.ui?.notify?.("A2A adaptor initialized", "info");
  });

  pi.on("session_shutdown", async () => {
    // Stop all async polling
    for (const [, pt] of pendingTasks) {
      if (pt.pollingInterval) clearInterval(pt.pollingInterval);
    }
    pendingTasks.clear();
    a2aClient?.cancelAll();
    a2aClient = null;
    registry = null;
    taskManager = null;
    config = null;
  });

  // ═══════════════════════════════════════════════════════════
  // COMMANDS
  // ═══════════════════════════════════════════════════════════

  /**
   * /a2a-discover <url>
   */
  pi.registerCommand("a2a-discover", {
    description: "Discover an A2A agent at a URL",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui?.notify?.("Usage: /a2a-discover <url>", "warning");
        return;
      }
      try {
        const agent = await registry!.discover(a2aClient!, url);
        const info = [
          `Name: ${agent.name}`,
          `Description: ${agent.description}`,
          `Version: ${agent.version}`,
          `URL: ${agent.url}`,
          `Skills: ${agent.skills.map((s) => s.name).join(", ")}`,
          `Streaming: ${agent.capabilities.streaming ? "yes" : "no"}`,
          `Push Notifications: ${agent.capabilities.pushNotifications ? "yes" : "no"}`,
        ].join("\n");
        ctx.ui?.notify?.(`Discovered: ${agent.name}\n${info}`, "success");
      } catch (err: any) {
        ctx.ui?.notify?.(`Discovery failed: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-agents
   */
  pi.registerCommand("a2a-agents", {
    description: "List all discovered A2A agents",
    handler: async (_args, ctx) => {
      const agents = registry!.list();
      if (agents.length === 0) {
        ctx.ui?.notify?.("No agents discovered. Use /a2a-discover <url>", "info");
        return;
      }
      const list = agents.map((a, i) => `${i + 1}. ${a.name} (${a.url}) - ${a.skills.length} skills`).join("\n");
      ctx.ui?.notify?.(`Discovered Agents:\n${list}\n\nUse number, name, or URL with /a2a-send`, "info");
    },
  });

  /**
   * /a2a-send <agent-ref> <message>
   */
  pi.registerCommand("a2a-send", {
    description: "Send a task to an A2A agent",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui?.notify?.("Usage: /a2a-send <agent-url-or-name> <message>", "warning");
        return;
      }
      const agentRef = parts[0];
      const message = parts.slice(1).join(" ");
      try {
        const agent = resolveAgent(agentRef);
        ctx.ui?.notify?.(`Sending to ${agent.name}...`, "info");
        const result = await taskManager!.sendTask(agent, message, {
          polling: { intervalMs: 2000, maxAttempts: 60, timeoutMs: 120000 },
        });
        const text = extractTextFromResult(result);
        ctx.ui?.notify?.(`Result:\n${text}`, "success");
      } catch (err: any) {
        ctx.ui?.notify?.(`Task failed: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-send-async <agent-ref> <message>
   */
  pi.registerCommand("a2a-send-async", {
    description: "Send a task to an A2A agent asynchronously (returns immediately, polls in background)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui?.notify?.("Usage: /a2a-send-async <agent-url-or-name> <message>", "warning");
        return;
      }
      const agentRef = parts[0];
      const message = parts.slice(1).join(" ");
      try {
        const agent = resolveAgent(agentRef);
        // Submit without auto-polling — we'll handle polling in background
        const result = await taskManager!.sendTask(agent, message, { timeout: 5000 });

        // Guard: result must be a task (not a bare Message)
        if (!result || !(result as any).id || !(result as any).status) {
          const text = extractTextFromResult(result as any);
          ctx.ui?.notify?.(`Agent replied:\n${text}`, "success");
          return;
        }

        const taskId = (result as any).id as string;
        const state = (result as any).status?.state;

        if (state && ["completed", "failed", "canceled", "rejected"].includes(state)) {
          // Already done — notify immediately, don't track
          const text = extractTextFromResult(result as any);
          ctx.ui?.notify?.(`[A2A ${agent.name}] Task ${taskId.slice(0, 8)} completed:\n${text}`, "success");
        } else {
          // Still running — track and start background polling
          const pending: PendingTask = {
            id: taskId,
            agentUrl: agent.url,
            agentName: agent.name,
            message,
            submittedAt: Date.now(),
            pollingInterval: null,
          };
          const pollInterval = setInterval(async () => {
            try {
              const task = await a2aClient!.getTask(agent, taskId);
              if (["completed", "failed", "canceled", "rejected"].includes(task.status.state)) {
                clearInterval(pollInterval);
                pending.pollingInterval = null;
                const text = extractTextFromResult(task);
                if (task.status.state === "completed") {
                  ctx.ui?.notify?.(`[A2A ${agent.name}] Task ${taskId.slice(0, 8)} completed:\n${text}`, "success");
                } else {
                  ctx.ui?.notify?.(`[A2A ${agent.name}] Task ${taskId.slice(0, 8)} ${task.status.state}.`, "warning");
                }
                pendingTasks.delete(taskId);
              }
            } catch {
              // Poll error — keep trying
            }
          }, 5000);
          pending.pollingInterval = pollInterval;
          pendingTasks.set(taskId, pending);
        }

        ctx.ui?.notify?.(`Task submitted: ${taskId.slice(0, 8)} → ${agent.name}. Use /a2a-pending to track.`, "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Task submission failed: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-pending
   */
  pi.registerCommand("a2a-pending", {
    description: "List pending async A2A tasks",
    handler: async (_args, ctx) => {
      if (pendingTasks.size === 0) {
        ctx.ui?.notify?.("No pending async tasks", "info");
        return;
      }
      const lines: string[] = [];
      for (const [id, pt] of pendingTasks) {
        const elapsed = Math.round((Date.now() - pt.submittedAt) / 1000);
        lines.push(`${id.slice(0, 8)} → ${pt.agentName} (${elapsed}s ago): ${pt.message.slice(0, 60)}`);
      }
      ctx.ui?.notify?.(`Pending Tasks:\n${lines.join("\n")}\n\nUse /a2a-status <task-id> <url> for details`, "info");
    },
  });

  /**
   * /a2a-broadcast <message> --agents <url1,url2,...>
   */
  pi.registerCommand("a2a-broadcast", {
    description: "Broadcast a task to multiple agents in parallel",
    handler: async (args, ctx) => {
      const agentsMatch = args.match(/--agents\s+([^\s]+)/);
      const message = args.replace(/--agents\s+[^\s]+/, "").trim();
      if (!agentsMatch || !message) {
        ctx.ui?.notify?.("Usage: /a2a-broadcast <message> --agents <url1,url2,...>", "warning");
        return;
      }
      const urls = agentsMatch[1].split(",");
      try {
        ctx.ui?.notify?.(`Broadcasting to ${urls.length} agents...`, "info");
        const results = await taskManager!.sendParallelTasks(
          urls.map((url) => ({
            agent: resolveAgent(url),
            message,
            options: { timeout: 60000 },
          }))
        );
        const summary = results.map((r, i) => {
          const status = r.status?.state || "unknown";
          return `[${i + 1}] ${results[i] ? "✓" : "✗"} ${urls[i]}: ${status}`;
        }).join("\n");
        ctx.ui?.notify?.(`Results:\n${summary}`, "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Broadcast failed: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-chain <agent1> <task1> | <agent2> <task2> | ...
   */
  pi.registerCommand("a2a-chain", {
    description: "Chain tasks across multiple agents sequentially",
    handler: async (args, ctx) => {
      const steps = args.split("|").map((s) => s.trim()).filter(Boolean);
      if (steps.length === 0) {
        ctx.ui?.notify?.("Usage: /a2a-chain <agent1> <task1> | <agent2> <task2> | ...", "warning");
        return;
      }
      const chainSteps: Array<{ agent: RemoteAgent; message: string; options?: TaskOptions }> = [];
      try {
        for (const step of steps) {
          const parts = step.split(/\s+/);
          if (parts.length < 2) {
            ctx.ui?.notify?.(`Invalid step: ${step}`, "error");
            return;
          }
          const agentRef = parts[0];
          const task = parts.slice(1).join(" ");
          const agent = resolveAgent(agentRef);
          chainSteps.push({ agent, message: task, options: undefined });
        }
        ctx.ui?.notify?.(`Executing chain of ${chainSteps.length} steps...`, "info");
        const result = await taskManager!.sendChainTasks(chainSteps);
        const text = extractTextFromResult(result);
        ctx.ui?.notify?.(`Chain completed:\n${text}`, "success");
      } catch (err: any) {
        ctx.ui?.notify?.(`Chain failed: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-status <task-id> [agent-url]
   */
  pi.registerCommand("a2a-status", {
    description: "Get status of an A2A task",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 1) {
        ctx.ui?.notify?.("Usage: /a2a-status <task-id> [agent-url]", "warning");
        return;
      }
      const taskId = parts[0];
      const agentUrl = parts[1];
      try {
        let agent: RemoteAgent;
        if (agentUrl) {
          agent = resolveAgent(agentUrl);
        } else {
          ctx.ui?.notify?.("Agent URL required. Usage: /a2a-status <task-id> <agent-url>", "error");
          return;
        }
        const task = await a2aClient!.getTask(agent, taskId);
        const info = [
          `Task ID: ${task.id}`,
          `State: ${task.status.state}`,
          `Context ID: ${task.contextId}`,
          `Artifacts: ${task.artifacts?.length || 0}`,
          `History: ${task.history?.length || 0} messages`,
        ].join("\n");
        ctx.ui?.notify?.(info, "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Failed to get status: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-cancel <task-id> [agent-url]
   */
  pi.registerCommand("a2a-cancel", {
    description: "Cancel an A2A task",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui?.notify?.("Usage: /a2a-cancel <task-id> <agent-url>", "warning");
        return;
      }
      const taskId = parts[0];
      const agent = resolveAgent(parts[1]);
      try {
        const task = await a2aClient!.cancelTask(agent, taskId);
        ctx.ui?.notify?.(`Task ${taskId} canceled (state: ${task.status.state})`, "success");
      } catch (err: any) {
        ctx.ui?.notify?.(`Failed to cancel: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-list [context-id]
   */
  pi.registerCommand("a2a-list", {
    description: "List tasks on a remote agent",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui?.notify?.("Usage: /a2a-list <agent-url> [context-id]", "warning");
        return;
      }
      const agent = resolveAgent(parts[0]);
      const contextId = parts[1] || undefined;
      try {
        const result = await a2aClient!.listTasks(agent, contextId ? { contextId } : {});
        if (result.tasks.length === 0) {
          ctx.ui?.notify?.("No tasks found", "info");
          return;
        }
        const list = result.tasks.map((t) => `${t.id.slice(0, 8)}...  ${t.status.state}  ${t.artifacts?.length || 0} artifacts`).join("\n");
        ctx.ui?.notify?.(`Tasks (${result.totalSize || result.tasks.length}):\n${list}`, "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Failed to list tasks: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-resubscribe <task-id> <agent-url>
   */
  pi.registerCommand("a2a-resubscribe", {
    description: "Resubscribe to a task's event stream",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui?.notify?.("Usage: /a2a-resubscribe <task-id> <agent-url>", "warning");
        return;
      }
      const taskId = parts[0];
      const agent = resolveAgent(parts[1]);
      try {
        ctx.ui?.notify?.(`Resubscribing to task ${taskId.slice(0, 8)}...`, "info");
        const updates: string[] = [];
        await a2aClient!.resubscribeToTask(agent, taskId, (u) => {
          updates.push(`[${u.status?.state || "update"}] ${JSON.stringify(u).slice(0, 200)}`);
        });
        if (updates.length === 0) {
          ctx.ui?.notify?.("No updates received", "info");
        } else {
          ctx.ui?.notify?.(`Updates:\n${updates.slice(-5).join("\n")}`, "info");
        }
      } catch (err: any) {
        ctx.ui?.notify?.(`Resubscribe failed: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-config <key> <value>
   */
  pi.registerCommand("a2a-config", {
    description: "Configure A2A settings",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui?.notify?.("Usage: /a2a-config <key> <value>\nKeys: timeout, retryAttempts, cacheTtl, verifySsl", "warning");
        return;
      }
      const key = parts[0];
      const value = parts.slice(1).join(" ");
      try {
        if (!config) throw new Error("A2A not initialized");
        switch (key) {
          case "timeout":
            config.client.timeout = parseInt(value, 10);
            break;
          case "retryAttempts":
            config.client.retryAttempts = parseInt(value, 10);
            break;
          case "cacheTtl":
            config.discovery.cacheTtl = parseInt(value, 10);
            break;
          case "verifySsl":
            config.security.verifySsl = value.toLowerCase() === "true";
            break;
          default:
            ctx.ui?.notify?.(`Unknown key: ${key}`, "error");
            return;
        }
        // Reinitialize client with new config
        a2aClient = new A2AClient(config.client, config.security);
        taskManager = new TaskManager(a2aClient, registry!);
        ctx.ui?.notify?.(`Configuration updated: ${key} = ${value}`, "success");
      } catch (err: any) {
        ctx.ui?.notify?.(`Failed to set config: ${err.message}`, "error");
      }
    },
  });

  /**
   * /a2a-help
   */
  pi.registerCommand("a2a-help", {
    description: "Show A2A adaptor help",
    handler: async (_args, ctx) => {
      const help = `
A2A Adaptor Commands:

Discovery:
  /a2a-discover <url>           - Discover agent at URL
  /a2a-agents                   - List discovered agents

Task Management:
  /a2a-send <agent> <message>   - Send task (waits for result)
  /a2a-send-async <agent> <msg> - Send task (returns immediately, notifies on completion)
  /a2a-pending                  - List pending async tasks
  /a2a-broadcast <msg> --agents <urls> - Broadcast to multiple agents
  /a2a-chain <agent1> <task1> | <agent2> <task2> | ... - Chain tasks
  /a2a-status <task-id> <url>   - Get task status
  /a2a-cancel <task-id> <url>   - Cancel a task
  /a2a-list <url> [context-id]  - List tasks on agent
  /a2a-resubscribe <task-id> <url> - Resubscribe to task stream

Configuration:
  /a2a-config <key> <value>     - Configure settings
  /a2a-help                     - Show this help

Examples:
  /a2a-discover https://agent.example.com
  /a2a-send https://agent.example.com "Analyze this code"
  /a2a-send-async https://agent.example.com "Long task"
  /a2a-pending
  /a2a-broadcast "Check security" --agents https://agent1.com,https://agent2.com
  /a2a-chain scout "find bugs" | worker "fix {previous}"
  /a2a-config timeout 60000
      `.trim();
      ctx.ui?.notify?.(help, "info");
    },
  });

  // ═══════════════════════════════════════════════════════════
  // TOOLS
  // ═══════════════════════════════════════════════════════════

  /**
   * a2a_call tool
   */
  pi.registerTool({
    name: "a2a_call",
    label: "A2A Agent Call",
    description: "Call a remote A2A agent to perform a task",
    parameters: {
      type: "object",
      properties: {
        agent_url: { type: "string", description: "URL or name of the A2A agent" },
        message: { type: "string", description: "Task message to send" },
        timeout: { type: "number", description: "Timeout in milliseconds", default: 60000 },
      },
      required: ["agent_url", "message"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!taskManager) {
        return { content: [{ type: "text" as const, text: "A2A not initialized" }], isError: true };
      }
      try {
        const agent = resolveAgent(params.agent_url as string);
        const result = await taskManager.sendTask(agent, params.message as string, {
          timeout: (params.timeout as number) ?? 60000,
          polling: { intervalMs: 2000, maxAttempts: 30, timeoutMs: 120000 },
        });
        const text = extractTextFromResult(result);
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  });

  /**
   * a2a_parallel tool
   */
  pi.registerTool({
    name: "a2a_parallel",
    label: "A2A Parallel Call",
    description: "Call multiple A2A agents in parallel with the same message",
    parameters: {
      type: "object",
      properties: {
        agent_urls: { type: "array", items: { type: "string" }, description: "Array of agent URLs or names" },
        message: { type: "string", description: "Task message to send to all agents" },
        timeout: { type: "number", description: "Timeout in milliseconds", default: 60000 },
      },
      required: ["agent_urls", "message"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!taskManager) {
        return { content: [{ type: "text" as const, text: "A2A not initialized" }], isError: true };
      }
      try {
        const urls = params.agent_urls as string[];
        const steps = urls.map((url) => ({
          agent: resolveAgent(url),
          message: params.message as string,
          options: { timeout: (params.timeout as number) ?? 60000 },
        }));
        const results = await taskManager.sendParallelTasks(steps);
        const summary = results.map((r, i) => `[${urls[i]}] ${r.status?.state || "unknown"}:\n${extractTextFromResult(r)}`).join("\n\n");
        return { content: [{ type: "text" as const, text: summary }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  });
}
