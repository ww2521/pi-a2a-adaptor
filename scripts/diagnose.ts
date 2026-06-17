#!/usr/bin/env tsx
/**
 * /a2a-discover-all 诊断脚本
 * 用法: npx tsx diagnose.ts <gateway-url> [--key <api-key>]
 * 例如: npx tsx diagnose.ts http://192.168.1.100:4000 --key sk-xxx
 */

import { A2AClient } from "../src/client.js";

const args = process.argv.slice(2);
const gatewayUrl = args.find(a => !a.startsWith("--")) || "http://localhost:4000";
const keyMatch = args.join(" ").match(/--key\s+(\S+)/);
const apiKey = keyMatch ? keyMatch[1] : "";

const client = new A2AClient(
  { timeout: 30000, retryAttempts: 0, retryDelay: 0, maxConcurrentTasks: 10, streamingEnabled: true },
  {
    defaultScheme: apiKey ? "bearer" : "none",
    bearerToken: apiKey || undefined,
    verifySsl: true,
  }
);

async function main() {
  console.log("═══ 诊断 /a2a-discover-all ═══");
  console.log("Gateway:", gatewayUrl);
  console.log("API Key:", apiKey ? "✓ set (len=" + apiKey.length + ")" : "✗ not set");
  console.log();

  // DEBUG: log raw args
  console.log("DEBUG args:", args);
  console.log("DEBUG keyMatch:", keyMatch);
  console.log("DEBUG apiKey:", apiKey);

  // Step 1: Raw /v1/agents response
  console.log("─── Step 1: GET /v1/agents ───");
  let gatewayAgents: any[];
  try {
    gatewayAgents = await client.listGatewayAgents(gatewayUrl, apiKey);
    console.log(`Found ${gatewayAgents.length} agent(s)`);
    for (const ga of gatewayAgents) {
      console.log(`  agent_id: ${ga.agent_id || "N/A"}`);
      console.log(`  agent_name: ${ga.agent_name || "N/A"}`);
      console.log(`  name: ${ga.name || "N/A"}`);
      console.log(`  agent_card_params.url: ${ga.agent_card_params?.url || "N/A"}`);
    }
  } catch (e: any) {
    console.log(`❌ listGatewayAgents failed: ${e.message}`);
    return;
  }

  if (gatewayAgents.length === 0) {
    console.log("No agents found in gateway");
    return;
  }

  for (const ga of gatewayAgents) {
    const ref = ga.name || ga.agent_name || ga.agent_id;
    console.log(`\n─── Step 2: discover agent "${ref}" ───`);

    try {
      const agent = await client.discoverAgentFromGateway(gatewayUrl, ref, apiKey);
      console.log(`  ✓ Discovered: ${agent.name}`);
      console.log(`  → agent.url = "${agent.url}"`);
      console.log(`  → This URL is used for ALL A2A POST requests (message/send, tasks/get)`);

      // Check if url is the gateway or the backend
      const gwHost = new URL(gatewayUrl).hostname;
      const agentHost = new URL(agent.url).hostname;
      if (agentHost === gwHost) {
        console.log(`  ⚠️  agent.url points to the SAME host as gateway`);
        console.log(`     This means polling goes through gateway`);
      } else {
        console.log(`  ℹ️  agent.url points to a DIFFERENT host (${agentHost})`);
        console.log(`     This means polling goes DIRECTLY to the agent`);
      }

      // Step 3: Test sendMessage
      console.log(`\n─── Step 3: sendMessage ───`);
      console.log(`  POST to: ${agent.url}/`);
      console.log(`  Timeout: 30s`);
      const result = await client.sendMessage(agent, {
        role: "user",
        parts: [{ kind: "text", text: "diagnose test" }],
        messageId: `diag-${Date.now()}`,
        contextId: "diag-ctx",
      }, {
        blocking: false,
        polling: { intervalMs: 2000, maxAttempts: 0, timeoutMs: 0 },
      });

      const taskId = (result as any)?.id;
      const state = (result as any)?.status?.state;
      console.log(`  taskId: ${taskId || "NONE"}`);
      console.log(`  state: ${state || "NONE"}`);

      if (!taskId) {
        // LiteLLM returned a direct message response (sync), not an async task
        console.log(`  ⚠️  LiteLLM returned a DIRECT MESSAGE, not a task`);
        console.log(`     This means the agent completed synchronously.`);
        console.log(`     result shape:`, JSON.stringify(result).slice(0, 300));
        console.log(`     For /a2a-send-async, this is treated as an immediate reply.`);
        continue;
      }

      // Step 4: Test getTask (polling)
      console.log(`\n─── Step 4: getTask (simulate polling) ───`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        const task = await client.getTask(agent, taskId);
        console.log(`  ✓ getTask succeeded`);
        console.log(`  state: ${task.status.state}`);
        console.log(`  contextId: ${task.contextId}`);
        if (task.artifacts?.length > 0) {
          console.log(`  artifact: ${task.artifacts[0].parts[0].text?.slice(0, 100)}`);
        }
      } catch (e: any) {
        console.log(`  ❌ getTask FAILED: ${e.message}`);
        console.log(`  agent.url was: ${agent.url}`);
        console.log(`  This is likely the root cause — polling can't reach the agent`);
      }

    } catch (e: any) {
      console.log(`  ❌ discoverAgentFromGateway failed: ${e.message}`);
    }
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
