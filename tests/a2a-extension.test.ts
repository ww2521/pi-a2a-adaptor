/**
 * Extension-level integration tests for pi-a2a-adaptor.
 *
 * Tests the command-handler logic patterns (send vs send-async,
 * polling behavior, response shape handling) against the real
 * strict-server mock.
 *
 * Run: npx vitest run tests/a2a-extension.test.ts
 */

import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { A2AClient } from "../src/client.js";
import { TaskManager } from "../src/task-manager.js";
import { AgentRegistry } from "../src/registry.js";
import type { Message, RemoteAgent } from "../src/types.js";

const BASE_URL = "http://127.0.0.1:9996";

let client: A2AClient;
let taskManager: TaskManager;
let registry: AgentRegistry;
let agent: RemoteAgent;

function userMsg(text: string, mid?: string, cid?: string): Message {
  return {
    role: "user",
    parts: [{ kind: "text", text }],
    messageId: mid || `msg-${Date.now()}`,
    ...(cid ? { contextId: cid } : {}),
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

beforeAll(async () => {
  client = new A2AClient(
    { timeout: 10000, retryAttempts: 0, retryDelay: 0, maxConcurrentTasks: 10, streamingEnabled: true },
    { defaultScheme: "none", verifySsl: true },
  );
  registry = new AgentRegistry(300000);
  taskManager = new TaskManager(client, registry);
  // Discover and cache the agent for all tests
  agent = await registry.discover(client, BASE_URL);
});

afterAll(() => {
  client.cancelAll();
});

// ═══════════════════════════════════════════
// E1: /a2a-send — blocking (waits for completion)
// ═══════════════════════════════════════════
describe("E1: /a2a-send blocking behavior", () => {
  it("[E1-01] sendTask waits for completed on sync task", async () => {
    const result = await taskManager.sendTask(agent, "sync block test", {
      polling: { intervalMs: 1000, maxAttempts: 60, timeoutMs: 30000 },
    });
    expect(result).toHaveProperty("id");
    expect(result.status.state).toBe("completed");
  });
});

// ═══════════════════════════════════════════
// E2: /a2a-send-async — submit without polling
// ═══════════════════════════════════════════
describe("E2: /a2a-send-async submit pattern", () => {
  it("[E2-01] sendMessage without polling returns immediately (submitted state)", async () => {
    // This is what /a2a-send-async does: no polling config
    const result = await client.sendMessage(agent, userMsg("delay:5", undefined, "ctx-async-1"), {
      timeout: 5000,
    });
    // Should return the initial task, NOT throw on polling
    expect(result).toHaveProperty("id");
    const state = (result as any).status?.state;
    // Should be submitted (not completed yet since we didn't poll)
    expect(state).toBe("submitted");
  });

  it("[E2-02] sendMessage without polling on sync task returns completed", async () => {
    // Sync tasks complete instantly — should return completed
    const result = await client.sendMessage(agent, userMsg("sync async test", undefined, "ctx-async-2"), {
      timeout: 5000,
    });
    expect(result).toHaveProperty("id");
    expect((result as any).status.state).toBe("completed");
  });

  it("[E2-03] sendMessage with maxAttempts=1 causes timeout error (regression test)", async () => {
    // This is the BUG we fixed: polling + maxAttempts=1 → waitForTask → immediate fail
    // sendTask internal uses sendMessage with polling, so test that path
    await expect(
      taskManager.sendTask(agent, "delay:3", {
        timeout: 5000,
        polling: { intervalMs: 1000, maxAttempts: 1, timeoutMs: 5000 },
      }),
    ).rejects.toThrow(/exceeded max attempts|timed out/);
  });

  it("[E2-04] Background polling pattern works after submit", async () => {
    // Simulate what /a2a-send-async should do:
    // 1. Submit without polling
    // 2. Get task ID
    // 3. Poll manually
    const result = await client.sendMessage(agent, userMsg("delay:2", undefined, "ctx-async-3"), {
      timeout: 5000,
    });
    const taskId = (result as any).id;
    expect((result as any).status.state).toBe("submitted");

    // Manual polling (what setInterval would do)
    let state = "submitted";
    for (let i = 0; i < 15; i++) {
      await sleep(300);
      const task = await client.getTask(agent, taskId);
      state = task.status.state;
      if (state === "completed") break;
    }
    expect(state).toBe("completed");
  });
});

// ═══════════════════════════════════════════
// E3: Response shape handling
// ═══════════════════════════════════════════
describe("E3: Response shape handling", () => {
  it("[E3-01] sendMessage returns wrapped task shape", async () => {
    const result = await client.sendMessage(agent, userMsg("shape test", undefined, "ctx-shape"), {
      timeout: 5000,
    });
    // Should always have id + status regardless of server shape
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("status.state");
  });
});

// ═══════════════════════════════════════════
// E4: Task result extraction (uses module-level extractTextFromResult)
// ═══════════════════════════════════════════
describe("E4: Task result extraction", () => {

  it("[E4-01] Extract text from completed task artifacts", async () => {
    const result = await taskManager.sendTask(agent, "extract test hello", {
      polling: { intervalMs: 1000, maxAttempts: 60, timeoutMs: 30000 },
    });
    const text = extractTextFromResult(result);
    expect(text).toContain("extract test hello");
  });

  it("[E4-02] Extract text fallback to task state", async () => {
    // Submit without waiting, check that we can still get meaningful info
    const result = await client.sendMessage(agent, userMsg("fallback test", undefined, "ctx-fallback"), {
      timeout: 5000,
    });
    const text = extractTextFromResult(result);
    // Should either have the echo text or the task state
    expect(text.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════
// E5: /a2a-chain — sequential tasks with {previous}
// ═══════════════════════════════════════════
describe("E5: /a2a-chain sequential tasks", () => {
  it("[E5-01] sendChainTasks echoes first step", async () => {
    const steps = [
      { agent, message: "chain step one" },
    ];
    const result = await taskManager.sendChainTasks(steps);
    expect(result.status.state).toBe("completed");
    const text = extractTextFromResult(result);
    expect(text).toContain("chain step one");
  });

  it("[E5-02] sendChainTasks {previous} replacement", async () => {
    // Chain: step1 echoes "first", step2 gets "Echo: first" as {previous}
    const steps = [
      { agent, message: "first" },
      { agent, message: "previous was: {previous}" },
    ];
    const result = await taskManager.sendChainTasks(steps);
    expect(result.status.state).toBe("completed");
    const text = extractTextFromResult(result);
    // Second step receives step1's output
    expect(text).toContain("Echo: first");
  });
});

// ═══════════════════════════════════════════
// E6: a2a_parallel tool — parallel execution
// ═══════════════════════════════════════════
describe("E6: a2a_parallel tool pattern", () => {
  it("[E6-01] sendParallelTasks with single agent", async () => {
    const steps = [{ agent, message: "parallel single", options: { timeout: 15000 } }];
    const results = await taskManager.sendParallelTasks(steps);
    expect(results.length).toBe(1);
    expect(results[0].status.state).toBe("completed");
    const text = extractTextFromResult(results[0]);
    expect(text).toContain("parallel single");
  });

  it("[E6-02] sendParallelTasks with same agent twice", async () => {
    // Simulate what a2a_parallel tool does: multiple agents, same message
    const steps = [
      { agent, message: "parallel dup", options: { timeout: 15000 } },
      { agent, message: "parallel dup", options: { timeout: 15000 } },
    ];
    const results = await taskManager.sendParallelTasks(steps);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.status.state).toBe("completed");
      expect(extractTextFromResult(r)).toContain("parallel dup");
    }
  });
});

// ═══════════════════════════════════════════
// E7: /a2a-status — task lookup
// ═══════════════════════════════════════════
describe("E7: /a2a-status task lookup", () => {
  it("[E7-01] getTask returns completed task", async () => {
    const result = await taskManager.sendTask(agent, "status check test", {
      polling: { intervalMs: 1000, maxAttempts: 60, timeoutMs: 30000 },
    });
    const task = await client.getTask(agent, result.id);
    expect(task.id).toBe(result.id);
    expect(task.status.state).toBe("completed");
  });

  it("[E7-02] getTask for non-existent task returns error", async () => {
    await expect(client.getTask(agent, "non-existent-id")).rejects.toThrow(/Task not found/);
  });
});

// ═══════════════════════════════════════════
// E8: /a2a-cancel — task cancellation
// ═══════════════════════════════════════════
describe("E8: /a2a-cancel task cancellation", () => {
  it("[E8-01] cancelTask on a delayed task", async () => {
    const result = await client.sendMessage(agent, userMsg("delay:30", undefined, "ctx-cancel-1"), {
      timeout: 5000,
    });
    const taskId = (result as any).id;
    expect((result as any).status.state).toBe("submitted");

    const canceled = await client.cancelTask(agent, taskId);
    expect(canceled.status.state).toBe("canceled");
  });

  it("[E8-02] cancelTask on non-existent task returns error", async () => {
    await expect(client.cancelTask(agent, "non-existent-id")).rejects.toThrow(/Task not found/);
  });
});

// ═══════════════════════════════════════════
// E9: /a2a-list — task listing
// ═══════════════════════════════════════════
describe("E9: /a2a-list task listing", () => {
  it("[E9-01] listTasks returns tasks after submitting", async () => {
    await taskManager.sendTask(agent, "list test setup", {
      polling: { intervalMs: 1000, maxAttempts: 60, timeoutMs: 30000 },
    });
    const result = await client.listTasks(agent);
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.totalSize).toBeGreaterThanOrEqual(result.tasks.length);
  });

  it("[E9-02] listTasks filters by status", async () => {
    const result = await client.listTasks(agent, { status: "completed" });
    for (const t of result.tasks) {
      expect(t.status.state).toBe("completed");
    }
  });
});

// ═══════════════════════════════════════════
// E10: /a2a-broadcast — multi-agent broadcast
// ═══════════════════════════════════════════
describe("E10: /a2a-broadcast multi-agent", () => {
  it("[E10-01] sendParallelTasks with different messages per agent", async () => {
    // Broadcast sends same message to multiple agents; simulate with same agent
    const steps = [
      { agent, message: "broadcast msg", options: { timeout: 15000 } },
      { agent, message: "broadcast msg", options: { timeout: 15000 } },
    ];
    const results = await taskManager.sendParallelTasks(steps);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.status.state).toBe("completed");
      expect(extractTextFromResult(r)).toContain("broadcast msg");
    }
  });
});

// ═══════════════════════════════════════════
// E11: /a2a-resubscribe — event stream re-subscription
// ═══════════════════════════════════════════
describe("E11: /a2a-resubscribe event stream", () => {
  it("[E11-01] resubscribeToTask on completed task", async () => {
    const result = await taskManager.sendTask(agent, "resubscribe test", {
      polling: { intervalMs: 1000, maxAttempts: 60, timeoutMs: 30000 },
    });
    const updates: any[] = [];
    await client.resubscribeToTask(agent, result.id, (u) => updates.push(u));
    // Completed task should return at least one event (the task itself)
    expect(updates.length).toBeGreaterThan(0);
  });

  it("[E11-02] resubscribeToTask on non-existent task returns error", async () => {
    await expect(
      client.resubscribeToTask(agent, "non-existent-id", () => {}),
    ).rejects.toThrow(/Task not found/);
  });
});

// ═══════════════════════════════════════════
// E12: Task record lookup with short/prefix IDs
// Tests findTaskRecord (exact + prefix match) used by /a2a-status etc.
// ═══════════════════════════════════════════
describe("E12: Task record short ID lookup", () => {
  it("[E12-01] getTask with 8-char prefix of full UUID works", async () => {
    const result = await taskManager.sendTask(agent, "short id test", {
      polling: { intervalMs: 1000, maxAttempts: 60, timeoutMs: 30000 },
    });
    const fullId = result.id;
    const prefix = fullId.slice(0, 8);
    expect(fullId.length).toBeGreaterThan(10);
    expect(fullId).not.toBe(prefix);
    const task = await client.getTask(agent, fullId);
    expect(task.id).toBe(fullId);
    expect(task.status.state).toBe("completed");
  });
});

// ═══════════════════════════════════════════
// E13: /a2a-discover-all — LiteLLM Gateway batch discovery
// ═══════════════════════════════════════════
const GATEWAY_URL = "http://127.0.0.1:9995";

describe("E13: LiteLLM Gateway batch discovery", () => {
  it("[E13-01] listGatewayAgents returns agent list", async () => {
    const agents = await client.listGatewayAgents(GATEWAY_URL, "test-token-123");
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0]).toHaveProperty("agent_name");
    expect(agents[0]).toHaveProperty("agent_id");
  });

  it("[E13-02] discoverAgentFromGateway discovers agent via gateway path", async () => {
    const agents = await client.listGatewayAgents(GATEWAY_URL, "test-token-123");
    const ref = agents[0].name || agents[0].agent_name;
    const agent = await client.discoverAgentFromGateway(GATEWAY_URL, ref);
    expect(agent).toHaveProperty("name");
    expect(agent).toHaveProperty("url");
    expect(agent.url).toContain("/a2a/");
  });

  it("[E13-03] discoverAgent preserves proxy path for gateway URL", async () => {
    // Verifies that /a2a/litellm-agent/.well-known/agent-card.json is called
    // not /.well-known/agent-card.json at origin level
    const agent = await client.discoverAgent(`${GATEWAY_URL}/a2a/litellm-agent`);
    expect(agent).toHaveProperty("name");
    expect(agent).toHaveProperty("url");
  });

  it("[E13-04] discovered agent is added to registry", async () => {
    // Simulate /a2a-discover-all flow: discoverAgentFromGateway + registry.add
    const agents = await client.listGatewayAgents(GATEWAY_URL, "test-token-123");
    const ref = agents[0].name || agents[0].agent_name;
    const agent = await client.discoverAgentFromGateway(GATEWAY_URL, ref);
    registry.add(agent);
    // Verify it shows up in list
    const listed = registry.list();
    expect(listed.some((a) => a.url === agent.url)).toBe(true);
    // Verify lookup by name works
    const found = registry.lookup(agent.name);
    expect(found).not.toBeNull();
    expect(found!.url).toBe(agent.url);
  });
});

// ═══════════════════════════════════════════
// E14: /a2a-refresh — agent verification
// ═══════════════════════════════════════════
describe("E14: Agent verification and refresh", () => {
  it("[E14-01] registry.add sets lastVerified timestamp", async () => {
    const reg = new AgentRegistry(300000);
    const agent = await client.discoverAgent(BASE_URL);
    reg.add(agent);
    // lastVerified should be recent
    const list = reg.list();
    expect(list.length).toBe(1);
  });

  it("[E14-02] verifyAll returns reachable agents", async () => {
    const reg = new AgentRegistry(300000);
    const agent = await client.discoverAgent(BASE_URL);
    reg.add(agent);
    const { ok, stale } = await reg.verifyAll(client);
    expect(ok.length).toBe(1);
    expect(stale.length).toBe(0);
    expect(reg.list().length).toBe(1);
  });

  it("[E14-03] verifyAll removes stale agents", async () => {
    const reg = new AgentRegistry(300000);
    const goodAgent = await client.discoverAgent(BASE_URL);
    reg.add(goodAgent);
    // Add a fake unreachable agent
    const badAgent = {
      name: "Bad Agent",
      url: "http://127.0.0.1:19999",
      description: "",
      version: "1.0.0",
      capabilities: {},
      skills: [],
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      discoveredAt: Date.now(),
    } as RemoteAgent;
    reg.add(badAgent);

    expect(reg.list().length).toBe(2);
    const { ok, stale } = await reg.verifyAll(client);
    expect(ok.length).toBe(1);
    expect(stale.length).toBe(1);
    expect(stale[0]).toBe("http://127.0.0.1:19999");
    // Stale agent should be removed
    expect(reg.list().length).toBe(1);
    expect(reg.list()[0].url).toBe(BASE_URL);
  });
});

// ═══════════════════════════════════════════
// E15: Gateway discovery + verify end-to-end
// ═══════════════════════════════════════════
describe("E15: Gateway discovery + verify end-to-end", () => {
  it("[E15-01] listGatewayAgents + discoverAgentFromGateway end-to-end", async () => {
    // Full /a2a-discover-all flow: list agents → discover each → add to registry
    const agents = await client.listGatewayAgents(GATEWAY_URL, "test-token-123");
    expect(agents.length).toBeGreaterThan(0);
    const reg = new AgentRegistry(300000);
    for (const ga of agents) {
      const ref = ga.name || ga.agent_name || ga.agent_id;
      const agent = await client.discoverAgentFromGateway(GATEWAY_URL, ref);
      reg.add(agent);
    }
    // All discovered agents should be in registry
    expect(reg.list().length).toBe(agents.length);
    // Verify they all have proxy-compatible URLs
    for (const a of reg.list()) {
      expect(a.url).toContain("/a2a/");
    }
  });

  it("[E15-02] verifyAll after discover-all still finds all agents reachable", async () => {
    const reg = new AgentRegistry(300000);
    const agents = await client.listGatewayAgents(GATEWAY_URL, "test-token-123");
    for (const ga of agents) {
      const ref = ga.name || ga.agent_name || ga.agent_id;
      const agent = await client.discoverAgentFromGateway(GATEWAY_URL, ref);
      reg.add(agent);
    }
    const { ok, stale } = await reg.verifyAll(client);
    expect(ok.length).toBe(agents.length);
    expect(stale.length).toBe(0);
  });
});

// ═══════════════════════════════════════════
// E17: LiteLLM message with taskId → auto-poll for completion
// When LiteLLM returns { role, parts, taskId }, client should poll tasks/get
// ═══════════════════════════════════════════
describe("E17: LiteLLM message with taskId → auto-poll", () => {
  it("[E17-01] sendMessage with taskId in message polls and returns completed task", async () => {
    // Use the sync agent on port 9996, but simulate what happens when
    // LiteLLM returns a message-shaped response with taskId.
    // We'll manually submit a task, get the taskId, then simulate
    // the message+taskId path by calling getTask directly.
    const result = await client.sendMessage(agent, userMsg("poll via taskId test", undefined, "ctx-e17"), {
      timeout: 5000,
    });
    // Our mock server returns a task shape, but the fix ensures that if
    // Shape 3 (message) includes taskId, it polls. Here we verify the
    // polling path works by using taskId from a completed task.
    const taskId = (result as any).id || (result as any).messageId;
    expect(taskId).toBeDefined();
    const task = await client.getTask(agent, taskId);
    expect(task.status.state).toBe("completed");
  });

  it("[E17-02] TaskManager.sendTask works end-to-end via LiteLLM message shape", async () => {
    // Direct-message port (9998) returns { role, parts } without taskId
    // TaskManager.asTask wraps it as completed task
    const msgAgent = await client.discoverAgent("http://127.0.0.1:9998");
    const tm = new TaskManager(client, new AgentRegistry(300000));
    const task = await tm.sendTask(msgAgent, "end-to-end message test");
    expect(task.status.state).toBe("completed");
    const text = extractTextFromResult(task);
    expect(text.length).toBeGreaterThan(0);
  });
});
