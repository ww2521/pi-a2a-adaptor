import { JSONRPCErrorCode } from "./types.js";
export class A2AError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = "A2AError";
    }
    static fromResponse(response) {
        const err = response.error;
        return new A2AError(err.code, err.message, err.data);
    }
    isTaskNotFound() { return this.code === JSONRPCErrorCode.TaskNotFound; }
    isTaskNotCancelable() { return this.code === JSONRPCErrorCode.TaskNotCancelable; }
    isPushNotSupported() { return this.code === JSONRPCErrorCode.PushNotificationNotSupported; }
    isUnsupportedOperation() { return this.code === JSONRPCErrorCode.UnsupportedOperation; }
    isTimeout() { return this.code === JSONRPCErrorCode.TaskTimeout; }
}
export class AgentDiscoveryError extends Error {
    url;
    constructor(message, url) {
        super(`Failed to discover agent at ${url}: ${message}`);
        this.url = url;
        this.name = "AgentDiscoveryError";
    }
}
export class TransportError extends Error {
    status;
    url;
    constructor(message, status, url) {
        super(message);
        this.status = status;
        this.url = url;
        this.name = "TransportError";
    }
}
