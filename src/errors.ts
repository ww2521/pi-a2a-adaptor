import type { JSONRPCResponse } from "./types.js";
import { JSONRPCErrorCode } from "./types.js";

export class A2AError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown
  ) {
    super(message);
    this.name = "A2AError";
  }

  static fromResponse(response: JSONRPCResponse): A2AError {
    const err = response.error!;
    return new A2AError(err.code, err.message, err.data);
  }

  isTaskNotFound(): boolean { return this.code === JSONRPCErrorCode.TaskNotFound; }
  isTaskNotCancelable(): boolean { return this.code === JSONRPCErrorCode.TaskNotCancelable; }
  isPushNotSupported(): boolean { return this.code === JSONRPCErrorCode.PushNotificationNotSupported; }
  isUnsupportedOperation(): boolean { return this.code === JSONRPCErrorCode.UnsupportedOperation; }
  isTimeout(): boolean { return this.code === JSONRPCErrorCode.TaskTimeout; }
}

export class AgentDiscoveryError extends Error {
  constructor(message: string, public url: string) {
    super(`Failed to discover agent at ${url}: ${message}`);
    this.name = "AgentDiscoveryError";
  }
}

export class TransportError extends Error {
  constructor(message: string, public status?: number, public url?: string) {
    super(message);
    this.name = "TransportError";
  }
}
