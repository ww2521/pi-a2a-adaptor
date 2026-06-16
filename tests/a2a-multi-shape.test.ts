/**
 * Multi-shape response tests for pi-a2a-adaptor.
 *
 * Tests A2AClient against strict-server with different response shapes:
 *   - port 9996: wrapped        { result: { kind: "task", task: {...} } }
 *   - port 9997: direct-task    { result: { id, status, ... } }
 *   - port 9998: direct-message { result: { role, parts, messageId } }
 *
 * Different A2A server implementations return different shapes.
 * The client must handle all of them.
 *
 * Run: npx vitest run tests/a2a-multi-shape.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { A2AClient } from "../src/client.js";
import type { Message, RemoteAgent } from "../src/types.js";

const PORT_WRAPPED = 9996;
const PORT_DIRECT_TASK = 9997;
const PORT_DIRECT_MSG = 9998;

let client: A2AClient;

function userMsg(text: string, mid?: string, cid?: string): Message {
  return {
    role: "user",
    parts: [{ kind: "text", text }],
    messageId: mid || `msg-${Date.now()}`,
    ...(cid ? { contextId: cid } : {}),
  };
}

async function makeAgent(port: number): Promise<RemoteAgent> {
  client = new A2AClient(
    { timeout: 10000, retryAttempts: 0, retryDelay: 0, maxConcurrentTasks: 10, streamingEnabled: true },
    { defaultScheme: "none", verifySsl: true },
  );
  return client.discoverAgent(`http://127.0.0.1:${port}`);
}

afterAll(() => {
  client.cancelAll();
});

// ═══════════════════════════════════════════
// S1: Wrapped shape (original, strict-server default)
// ═══════════════════════════════════════════
describe("S1: Wrapped response shape { kind: 'task', task: {...} }", () => {
  let agent: RemoteAgent;
  beforeAll(async () => { agent = await makeAgent(PORT_WRAPPED); });

  it("[S1-01] sendMessage returns task with wrapped shape", async () => {
    const result = await client.sendMessage(agent, userMsg("wrapped sync test", undefined, "ctx-s1"));
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("status");
    expect((result as any).status.state).toBe("completed");
  });

  it("[S1-02] Wrapped shape has artifacts", async () => {
    const result = await client.sendMessage(agent, userMsg("wrapped artifact test", undefined, "ctx-s1a"));
    expect(result).toHaveProperty("artifacts");
    expect((result as any).artifacts.length).toBeGreaterThan(0);
    const text = (result as any).artifacts[0].parts[0].text;
    expect(text).toContain("wrapped artifact test");
  });

  it("[S1-03] Wrapped shape works with getTask", async () => {
    const result = await client.sendMessage(agent, userMsg("wrapped gettask", undefined, "ctx-s1b"));
    const taskId = (result as any).id;
    const task = await client.getTask(agent, taskId);
    expect(task.id).toBe(taskId);
    expect(task.status.state).toBe("completed");
  });
});

// ═══════════════════════════════════════════
// S2: Direct-task shape (the shape that caused the original bug)
// ═══════════════════════════════════════════
describe("S2: Direct-task response shape { id, status, ... }", () => {
  let agent: RemoteAgent;
  beforeAll(async () => { agent = await makeAgent(PORT_DIRECT_TASK); });

  it("[S2-01] sendMessage returns task with direct-task shape", async () => {
    const result = await client.sendMessage(agent, userMsg("direct task test", undefined, "ctx-s2"));
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("status");
    expect((result as any).status.state).toBe("completed");
  });

  it("[S2-02] Direct-task shape has artifacts", async () => {
    const result = await client.sendMessage(agent, userMsg("direct artifact test", undefined, "ctx-s2a"));
    expect(result).toHaveProperty("artifacts");
    expect((result as any).artifacts.length).toBeGreaterThan(0);
    const text = (result as any).artifacts[0].parts[0].text;
    expect(text).toContain("direct artifact test");
  });

  it("[S2-03] Direct-task shape works with getTask", async () => {
    const result = await client.sendMessage(agent, userMsg("gettask test", undefined, "ctx-s2b"));
    const taskId = (result as any).id;
    const task = await client.getTask(agent, taskId);
    expect(task.id).toBe(taskId);
    expect(task.status.state).toBe("completed");
  });
});

// ═══════════════════════════════════════════
// S3: Direct-message shape (message returned directly, not wrapped in task)
// ═══════════════════════════════════════════
describe("S3: Direct-message response shape { role, parts, messageId }", () => {
  let agent: RemoteAgent;
  beforeAll(async () => { agent = await makeAgent(PORT_DIRECT_MSG); });

  it("[S3-01] sendMessage returns message with direct-message shape", async () => {
    const result = await client.sendMessage(agent, userMsg("direct msg test", undefined, "ctx-s3"));
    expect(result).toHaveProperty("role");
    expect(result).toHaveProperty("parts");
    expect(result).toHaveProperty("messageId");
    // Should NOT have task properties
    expect(result).not.toHaveProperty("status");
  });

  it("[S3-02] Direct-message shape has correct parts", async () => {
    const result = await client.sendMessage(agent, userMsg("parts check", undefined, "ctx-s3a"));
    const parts = (result as any).parts;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0].kind).toBe("text");
    expect(parts[0].text).toContain("parts check");
  });
});
