import * as http from "node:http";
import * as https from "node:https";
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
};
const ENDPOINTS = {
    AGENT_CARD: "/.well-known/agent-card.json",
    DISPATCH: "/",
};
const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
export class A2AClient {
    config;
    security;
    pendingStreams = new Map();
    requestIdCounter = 0;
    constructor(config, security) {
        this.config = config;
        this.security = security;
    }
    // ─── Agent Discovery ───
    async discoverAgent(url) {
        const agentUrl = new URL(url);
        const cardUrl = `${agentUrl.origin}${ENDPOINTS.AGENT_CARD}`;
        const card = (await this.httpGet(cardUrl));
        return { ...card, url: card.url || url, discoveredAt: Date.now() };
    }
    // ─── Core Methods ───
    async sendMessage(agent, message, options = {}) {
        if (!message.contextId)
            message.contextId = this.generateId();
        const request = this.createRequest(METHODS.SEND_MESSAGE, {
            message,
            configuration: this.buildSendConfig(options),
            metadata: options.metadata,
        });
        const response = await this.httpPostJSON(agent, request, options);
        if (response.error)
            throw A2AError.fromResponse(response);
        const result = response.result;
        if (result?.task) {
            if (!TERMINAL_STATES.has(result.task.status.state) && options.polling) {
                return this.waitForTask(agent, result.task.id, options.polling);
            }
            return result.task;
        }
        if (result?.message)
            return result.message;
        throw new A2AError(JSONRPCErrorCode.InvalidAgentResponse, "Invalid response: no task or message");
    }
    async sendStreamingMessage(agent, message, onUpdate, options = {}) {
        if (!message.contextId)
            message.contextId = this.generateId();
        const request = this.createRequest(METHODS.STREAM_MESSAGE, {
            message,
            configuration: this.buildSendConfig(options),
            metadata: options.metadata,
        });
        return this.sseRequest(agent, request, onUpdate);
    }
    async getTask(agent, taskId, historyLength) {
        const params = { id: taskId };
        if (historyLength !== undefined)
            params.historyLength = historyLength;
        const request = this.createRequest(METHODS.GET_TASK, params);
        const response = await this.httpPostJSON(agent, request);
        if (response.error)
            throw A2AError.fromResponse(response);
        return response.result;
    }
    async cancelTask(agent, taskId) {
        const request = this.createRequest(METHODS.CANCEL_TASK, { id: taskId });
        const response = await this.httpPostJSON(agent, request);
        if (response.error)
            throw A2AError.fromResponse(response);
        return response.result;
    }
    async listTasks(agent, params = {}) {
        const request = this.createRequest(METHODS.LIST_TASKS, params);
        const response = await this.httpPostJSON(agent, request);
        if (response.error)
            throw A2AError.fromResponse(response);
        return response.result;
    }
    async resubscribeToTask(agent, taskId, onUpdate, signal) {
        const request = this.createRequest(METHODS.RESUBSCRIBE, { id: taskId });
        return new Promise((resolve, reject) => {
            const abortController = new AbortController();
            if (signal)
                signal.addEventListener("abort", () => { abortController.abort(); resolve(); });
            this.sendStreamingRequest(agent, request, abortController.signal, (rawData) => {
                const response = rawData;
                if (response.error) {
                    reject(A2AError.fromResponse(response));
                    return;
                }
                const result = response.result;
                if (!result)
                    return;
                if (result.kind === "task") {
                    onUpdate({ id: result.task.id, contextId: result.task.contextId, status: result.task.status });
                    if (TERMINAL_STATES.has(result.task.status.state))
                        resolve();
                }
                if (result.kind === "status-update") {
                    onUpdate({ id: result.taskId, contextId: result.contextId, status: result.status });
                    if (TERMINAL_STATES.has(result.status.state))
                        resolve();
                }
                if (result.kind === "artifact-update") {
                    onUpdate({ id: result.taskId, contextId: result.contextId, artifacts: [result.artifact] });
                }
            }).catch(reject);
        });
    }
    async setPushNotification(agent, taskId, config) {
        const request = this.createRequest(METHODS.PUSH_SET, { ...config, taskId });
        const response = await this.httpPostJSON(agent, request);
        if (response.error)
            throw A2AError.fromResponse(response);
        return response.result;
    }
    async getPushNotification(agent, taskId) {
        const request = this.createRequest(METHODS.PUSH_GET, { taskId });
        const response = await this.httpPostJSON(agent, request);
        if (response.error)
            throw A2AError.fromResponse(response);
        return response.result;
    }
    async listPushNotificationConfigs(agent, taskId) {
        const request = this.createRequest(METHODS.PUSH_LIST, { taskId });
        const response = await this.httpPostJSON(agent, request);
        if (response.error)
            throw A2AError.fromResponse(response);
        return response.result.configs;
    }
    async deletePushNotificationConfig(agent, taskId, configId) {
        const request = this.createRequest(METHODS.PUSH_DELETE, { taskId, id: configId });
        const response = await this.httpPostJSON(agent, request);
        if (response.error)
            throw A2AError.fromResponse(response);
    }
    cancelAll() {
        for (const [, ctrl] of this.pendingStreams)
            ctrl.abort();
        this.pendingStreams.clear();
    }
    // ─── Private Helpers ───
    TERMINAL_STATES = TERMINAL_STATES;
    async waitForTask(agent, taskId, options) {
        const { intervalMs = 2000, maxAttempts = 60, timeoutMs = 120000 } = options;
        const deadline = Date.now() + timeoutMs;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (Date.now() >= deadline)
                throw new A2AError(JSONRPCErrorCode.TaskTimeout, `Task ${taskId} timed out after ${timeoutMs}ms`);
            await this.delay(intervalMs);
            const task = await this.getTask(agent, taskId);
            if (this.TERMINAL_STATES.has(task.status.state))
                return task;
        }
        throw new A2AError(JSONRPCErrorCode.TaskTimeout, `Task ${taskId} exceeded max attempts (${maxAttempts})`);
    }
    async sseRequest(agent, request, onUpdate) {
        return new Promise((resolve, reject) => {
            const abortController = new AbortController();
            const requestId = String(request.id);
            this.pendingStreams.set(requestId, abortController);
            let latestTask = null;
            this.sendStreamingRequest(agent, request, abortController.signal, (rawData) => {
                const response = rawData;
                if (response.error) {
                    this.pendingStreams.delete(requestId);
                    reject(A2AError.fromResponse(response));
                    return;
                }
                const result = response.result;
                if (!result)
                    return;
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
    createRequest(method, params) {
        return { jsonrpc: "2.0", id: this.nextRequestId(), method, params: params ?? {} };
    }
    buildSendConfig(options) {
        return {
            acceptedOutputModes: options.acceptedOutputModes ?? ["text/plain", "application/json"],
            blocking: options.blocking ?? false,
            historyLength: options.historyLength,
            pushNotificationConfig: options.pushNotificationConfig,
        };
    }
    nextRequestId() { this.requestIdCounter++; return `${Date.now()}-${this.requestIdCounter.toString(36)}`; }
    generateId() { return `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
    delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
    getDispatchUrl(agent) { const origin = new URL(agent.url).origin; return `${origin}${ENDPOINTS.DISPATCH}`; }
    // ─── HTTP Transport ───
    httpMod(url) {
        return new URL(url).protocol === "https:" ? https : http;
    }
    async httpPostJSON(agent, request, options = {}) {
        const url = this.getDispatchUrl(agent);
        const body = JSON.stringify(request);
        const timeout = options.timeout ?? this.config.timeout;
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const req = this.httpMod(url).request({
                hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...this.buildAuthHeaders() }, timeout,
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => { try {
                    resolve(JSON.parse(data));
                }
                catch {
                    reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`));
                } });
            });
            req.on("error", reject);
            req.on("timeout", () => { req.destroy(); reject(new Error(`Request timed out after ${timeout}ms`)); });
            req.write(body);
            req.end();
        });
    }
    async httpGet(url) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const req = this.httpMod(url).request({
                hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "GET",
                headers: { ...this.buildAuthHeaders() }, timeout: this.config.timeout,
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    }
                    catch {
                        reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`));
                    }
                });
            });
            req.on("error", reject);
            req.end();
        });
    }
    sendStreamingRequest(agent, request, signal, callback) {
        return new Promise((resolve, reject) => {
            const url = this.getDispatchUrl(agent);
            const body = JSON.stringify(request);
            const req = this.httpMod(url).request({
                hostname: new URL(url).hostname, port: new URL(url).port, path: new URL(url).pathname, method: "POST",
                headers: { "Content-Type": "application/json", Accept: "text/event-stream", "Content-Length": Buffer.byteLength(body), ...this.buildAuthHeaders() },
                timeout: this.config.timeout,
            }, (res) => {
                let buf = "";
                res.on("data", (chunk) => {
                    buf += chunk;
                    const lines = buf.split("\n");
                    buf = lines.pop() ?? "";
                    for (const line of lines) {
                        if (line.startsWith("data: ")) {
                            const ds = line.slice(6).trim();
                            if (ds === "[DONE]") {
                                resolve();
                                return;
                            }
                            try {
                                callback(JSON.parse(ds));
                            }
                            catch { /* skip */ }
                        }
                    }
                });
                res.on("end", () => resolve());
                res.on("error", reject);
            });
            req.on("error", reject);
            signal.addEventListener("abort", () => { req.destroy(); resolve(); });
            req.write(body);
            req.end();
        });
    }
    buildAuthHeaders() {
        const h = {};
        if (this.security.defaultScheme === "bearer" && this.security.bearerToken)
            h["Authorization"] = `Bearer ${this.security.bearerToken}`;
        else if (this.security.defaultScheme === "apiKey" && this.security.apiKey)
            h["Authorization"] = `ApiKey ${this.security.apiKey}`;
        return h;
    }
}
