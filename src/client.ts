import * as http from "node:http";
import * as https from "node:https";
import type {
  A2AClientOptions,
  A2ATask,
  AgentCard,
  ClientConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  ListTasksParams,
  ListTasksResult,
  Message,
  PushNotificationConfig,
  RemoteAgent,
  SecurityConfig,
  StreamResult,
  TaskOptions,
  TaskUpdateCallback,
} from "./types.js";
import { A2AError } from "./errors.js";
import { JSONRPCErrorCode } from "./types.js";

const METHODS = {
  SEND_MESSAGE: "message/send",
  STREAM_MESSAGE: "message/stream",
  GET_TASK: "tasks/get",
  CANCEL_TASK: "tasks/cancel",
  RESUBSCRIBE: "tasks/resubscribe",
  LIST_TASKS: "tasks/list",
  PUSH_SET: "tasks/pushNotification/set",
  PUSH_GET: "tasks/pushNotification/get",
  PUSH_LIST: "tasks/pushNotificationConfig/list",
  PUSH_DELETE: "tasks/pushNotificationConfig/delete",
} as const;

const ENDPOINTS = {
  AGENT_CARD: "/.well-known/agent-card.json",
  AGENT_CARD_ALT: "/.well-known/agent.json",
  DISPATCH: "/",
} as const;

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);

export class A2AClient {
  private config: ClientConfig;
  private security: SecurityConfig;
  private pendingStreams = new Map<string, AbortController>();
  private requestIdCounter = 0;

  constructor(config: ClientConfig, security: SecurityConfig) {
    this.config = config;
    this.security = security;
  }

  // ─── Agent Discovery ───

  async discoverAgent(url: string): Promise<RemoteAgent> {
    const agentUrl = new URL(url);
    // Preserve the full path (e.g. /a2a/my-agent) for proxy-compatible URLs
    const basePath = agentUrl.pathname.replace(/\/$/, '');
    const origin = agentUrl.origin;
    const base = basePath ? `${origin}${basePath}` : origin;

    // Try standard A2A path first
    const cardUrl = `${base}${ENDPOINTS.AGENT_CARD}`;
    try {
      const card = (await this.httpGet(cardUrl)) as AgentCard;
      return { ...card, url: card.url || url, discoveredAt: Date.now() } as RemoteAgent;
    } catch (err: any) {
      // 404 → try LiteLLM agent.json fallback
      if (err.message && err.message.includes("HTTP 404")) {
        const altUrl = `${base}${ENDPOINTS.AGENT_CARD_ALT}`;
        const card = (await this.httpGet(altUrl)) as AgentCard;
        return { ...card, url: card.url || url, discoveredAt: Date.now() } as RemoteAgent;
      }
      throw err;
    }
  }

  // ─── Core Methods ───

  async sendMessage(agent: RemoteAgent, message: Message, options: TaskOptions = {}): Promise<A2ATask | Message> {
    if (!message.contextId) message.contextId = this.generateId();
    message.kind = "message";

    const request = this.createRequest(METHODS.SEND_MESSAGE, {
      message,
      configuration: this.buildSendConfig(options),
      metadata: options.metadata,
    });

    const response = await this.httpPostJSON(agent, request, options);
    if (response.error) throw A2AError.fromResponse(response);

    const raw = response.result as unknown;

    // Shape 1: { task: A2ATask }
    if (raw && typeof raw === "object" && "task" in raw) {
      const wrapped = raw as { task?: A2ATask; message?: Message };
      if (wrapped.task) {
        if (!TERMINAL_STATES.has(wrapped.task.status.state) && options.polling) {
          return this.waitForTask(agent, wrapped.task.id, options.polling);
        }
        return wrapped.task;
      }
      if (wrapped.message) return wrapped.message;
    }

    // Shape 2: direct A2ATask (status + id present)
    if (raw && typeof raw === "object" && "status" in raw && "id" in raw) {
      const task = raw as A2ATask;
      if (!TERMINAL_STATES.has(task.status.state) && options.polling) {
        return this.waitForTask(agent, task.id, options.polling);
      }
      return task;
    }

    // Shape 3: direct Message (role + parts present)
    if (raw && typeof raw === "object" && "role" in raw && "parts" in raw) {
      return raw as Message;
    }

    throw new A2AError(JSONRPCErrorCode.InvalidAgentResponse, "Invalid response: no task or message\nRaw: " + JSON.stringify(raw).slice(0, 500));
  }

  async sendStreamingMessage(
    agent: RemoteAgent,
    message: Message,
    onUpdate: TaskUpdateCallback,
    options: TaskOptions = {}
  ): Promise<A2ATask> {
    if (!message.contextId) message.contextId = this.generateId();
    message.kind = "message";

    const request = this.createRequest(METHODS.STREAM_MESSAGE, {
      message,
      configuration: this.buildSendConfig(options),
      metadata: options.metadata,
    });

    return this.sseRequest(agent, request, onUpdate);
  }

  async getTask(agent: RemoteAgent, taskId: string, historyLength?: number): Promise<A2ATask> {
    const params: Record<string, unknown> = { id: taskId };
    if (historyLength !== undefined) params.historyLength = historyLength;

    const request = this.createRequest(METHODS.GET_TASK, params);
    const response = await this.httpPostJSON(agent, request);
    if (response.error) throw A2AError.fromResponse(response);
    return response.result as unknown as A2ATask;
  }

  async cancelTask(agent: RemoteAgent, taskId: string): Promise<A2ATask> {
    const request = this.createRequest(METHODS.CANCEL_TASK, { id: taskId });
    const response = await this.httpPostJSON(agent, request);
    if (response.error) throw A2AError.fromResponse(response);
    return response.result as unknown as A2ATask;
  }

  async listTasks(agent: RemoteAgent, params: ListTasksParams = {}): Promise<ListTasksResult> {
    const request = this.createRequest(METHODS.LIST_TASKS, params as unknown as Record<string, unknown>);
    const response = await this.httpPostJSON(agent, request);
    if (response.error) throw A2AError.fromResponse(response);
    return response.result as unknown as ListTasksResult;
  }

  async resubscribeToTask(agent: RemoteAgent, taskId: string, onUpdate: TaskUpdateCallback, signal?: AbortSignal): Promise<void> {
    const request = this.createRequest(METHODS.RESUBSCRIBE, { id: taskId });

    return new Promise((resolve, reject) => {
      const abortController = new AbortController();
      if (signal) signal.addEventListener("abort", () => { abortController.abort(); resolve(); });

      this.sendStreamingRequest(agent, request, abortController.signal, (rawData) => {
        const response = rawData as JSONRPCResponse;
        if (response.error) { reject(A2AError.fromResponse(response)); return; }
        const result = response.result as StreamResult | undefined;
        if (!result) return;

        if (result.kind === "task") {
          onUpdate({ id: result.task.id, contextId: result.task.contextId, status: result.task.status });
          if (TERMINAL_STATES.has(result.task.status.state)) resolve();
        }
        if (result.kind === "status-update") {
          onUpdate({ id: result.taskId, contextId: result.contextId, status: result.status });
          if (TERMINAL_STATES.has(result.status.state)) resolve();
        }
        if (result.kind === "artifact-update") {
          onUpdate({ id: result.taskId, contextId: result.contextId, artifacts: [result.artifact] });
        }
      }).catch(reject);
    });
  }

  async setPushNotification(agent: RemoteAgent, taskId: string, config: PushNotificationConfig): Promise<PushNotificationConfig> {
    const request = this.createRequest(METHODS.PUSH_SET, { ...config, taskId } as unknown as Record<string, unknown>);
    const response = await this.httpPostJSON(agent, request);
    if (response.error) throw A2AError.fromResponse(response);
    return response.result as unknown as PushNotificationConfig;
  }

  async getPushNotification(agent: RemoteAgent, taskId: string): Promise<PushNotificationConfig> {
    const request = this.createRequest(METHODS.PUSH_GET, { taskId } as unknown as Record<string, unknown>);
    const response = await this.httpPostJSON(agent, request);
    if (response.error) throw A2AError.fromResponse(response);
    return response.result as unknown as PushNotificationConfig;
  }

  async listPushNotificationConfigs(agent: RemoteAgent, taskId: string): Promise<PushNotificationConfig[]> {
    const request = this.createRequest(METHODS.PUSH_LIST, { taskId } as unknown as Record<string, unknown>);
    const response = await this.httpPostJSON(agent, request);
    if (response.error) throw A2AError.fromResponse(response);
    return (response.result as unknown as { configs: PushNotificationConfig[] }).configs;
  }

  async deletePushNotificationConfig(agent: RemoteAgent, taskId: string, configId: string): Promise<void> {
    const request = this.createRequest(METHODS.PUSH_DELETE, { taskId, id: configId } as unknown as Record<string, unknown>);
    const response = await this.httpPostJSON(agent, request);
    if (response.error) throw A2AError.fromResponse(response);
  }

  cancelAll(): void {
    for (const [, ctrl] of this.pendingStreams) ctrl.abort();
    this.pendingStreams.clear();
  }

  // ─── LiteLLM Gateway ───

  /**
   * Fetch agents from LiteLLM Gateway /v1/agents endpoint.
   * Returns array of { agent_id, agent_name, agent_card_params, litellm_params, ... }
   */
  async listGatewayAgents(gatewayUrl: string, apiKey: string): Promise<any[]> {
    const url = `${gatewayUrl.replace(/\/$/, '')}/v1/agents`;
    const res = await this.httpGet(url, { Authorization: `Bearer ${apiKey}` });
    return Array.isArray(res) ? res : [];
  }

  /**
   * Discover an agent registered in LiteLLM Gateway by agent name or ID.
   * Uses /a2a/{agent_id}/.well-known/agent-card.json (standard path).
   */
  async discoverAgentFromGateway(gatewayUrl: string, agentRef: string): Promise<RemoteAgent> {
    const base = gatewayUrl.replace(/\/$/, '');
    return this.discoverAgent(`${base}/a2a/${agentRef}`);
  }

  // ─── Private Helpers ───

  private readonly TERMINAL_STATES = TERMINAL_STATES;

  private async waitForTask(agent: RemoteAgent, taskId: string, options: NonNullable<TaskOptions["polling"]>): Promise<A2ATask> {
    const { intervalMs = 2000, maxAttempts = 60, timeoutMs = 120000 } = options;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (Date.now() >= deadline) throw new A2AError(JSONRPCErrorCode.TaskTimeout, `Task ${taskId} timed out after ${timeoutMs}ms`);
      await this.delay(intervalMs);
      const task = await this.getTask(agent, taskId);
      if (this.TERMINAL_STATES.has(task.status.state)) return task;
    }
    throw new A2AError(JSONRPCErrorCode.TaskTimeout, `Task ${taskId} exceeded max attempts (${maxAttempts})`);
  }

  private async sseRequest(agent: RemoteAgent, request: JSONRPCRequest, onUpdate: TaskUpdateCallback): Promise<A2ATask> {
    return new Promise((resolve, reject) => {
      const abortController = new AbortController();
      const requestId = String(request.id);
      this.pendingStreams.set(requestId, abortController);
      let latestTask: A2ATask | null = null;

      this.sendStreamingRequest(agent, request, abortController.signal, (rawData) => {
        const response = rawData as JSONRPCResponse;
        if (response.error) { this.pendingStreams.delete(requestId); reject(A2AError.fromResponse(response)); return; }
        const result = response.result as StreamResult | undefined;
        if (!result) return;
        switch (result.kind) {
          case "task":
            latestTask = result.task;
            // Only resolve on terminal task state (final event)
            if (this.TERMINAL_STATES.has(result.task.status.state)) {
              this.pendingStreams.delete(requestId);
              resolve(result.task);
            }
            break;
          case "status-update":
            onUpdate({ id: result.taskId, contextId: result.contextId, status: result.status });
            if (result.final && latestTask) {
              this.pendingStreams.delete(requestId);
              resolve(latestTask);
            }
            break;
          case "artifact-update":
            onUpdate({ id: result.taskId, contextId: result.contextId, artifacts: [result.artifact] });
            if (latestTask) {
              latestTask = { ...latestTask, artifacts: [...(latestTask.artifacts || []), result.artifact] };
            }
            break;
        }
      }).catch((err) => { this.pendingStreams.delete(requestId); reject(err); });
    });
  }

  private createRequest(method: string, params?: Record<string, unknown>): JSONRPCRequest {
    return { jsonrpc: "2.0", id: this.nextRequestId(), method, params: params ?? {} };
  }

  private buildSendConfig(options: TaskOptions) {
    return {
      acceptedOutputModes: options.acceptedOutputModes ?? ["text/plain", "application/json"],
      blocking: options.blocking ?? false,
      historyLength: options.historyLength,
      pushNotificationConfig: options.pushNotificationConfig,
    };
  }

  private nextRequestId(): string { this.requestIdCounter++; return `${Date.now()}-${this.requestIdCounter.toString(36)}`; }
  private generateId(): string { return `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
  private delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
  private getDispatchUrl(agent: RemoteAgent): string {
    // Use agent.url as-is (may contain proxy path like /a2a/{agent_id})
    return agent.url;
  }

  // ─── HTTP Transport ───

  private httpMod(url: string): typeof http | typeof https {
    return new URL(url).protocol === "https:" ? https : http;
  }

  private async httpPostJSON(agent: RemoteAgent, request: JSONRPCRequest, options: TaskOptions = {}): Promise<JSONRPCResponse> {
    const url = this.getDispatchUrl(agent);
    const body = JSON.stringify(request);
    const timeout = options.timeout ?? this.config.timeout;
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = this.httpMod(url).request({
        hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...this.buildAuthHeaders() }, timeout,
      }, (res: http.IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); } });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error(`Request timed out after ${timeout}ms`)); });
      req.write(body); req.end();
    });
  }

  private async httpGet(url: string, extraHeaders?: Record<string, string>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = this.httpMod(url).request({
        hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "GET",
        headers: { ...this.buildAuthHeaders(), ...extraHeaders }, timeout: this.config.timeout,
      }, (res: http.IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)); return; }
          try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
        });
      });
      req.on("error", reject); req.end();
    });
  }

  private sendStreamingRequest(agent: RemoteAgent, request: JSONRPCRequest, signal: AbortSignal, callback: (data: unknown) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.getDispatchUrl(agent);
      const body = JSON.stringify(request);
      const req = this.httpMod(url).request({
        hostname: new URL(url).hostname, port: new URL(url).port, path: new URL(url).pathname, method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", "Content-Length": Buffer.byteLength(body), ...this.buildAuthHeaders() },
        timeout: this.config.timeout,
      }, (res: http.IncomingMessage) => {
        let buf = "";
        res.on("data", (chunk: string) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const ds = line.slice(6).trim();
              if (ds === "[DONE]") { resolve(); return; }
              try { callback(JSON.parse(ds)); } catch { /* skip */ }
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", reject);
      });
      req.on("error", reject);
      signal.addEventListener("abort", () => { req.destroy(); resolve(); });
      req.write(body); req.end();
    });
  }

  private buildAuthHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.security.defaultScheme === "bearer" && this.security.bearerToken) h["Authorization"] = `Bearer ${this.security.bearerToken}`;
    else if (this.security.defaultScheme === "apiKey" && this.security.apiKey) h["Authorization"] = `ApiKey ${this.security.apiKey}`;
    return h;
  }
}
