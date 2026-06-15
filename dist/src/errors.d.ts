import type { JSONRPCResponse } from "./types.js";
export declare class A2AError extends Error {
    code: number;
    data?: unknown | undefined;
    constructor(code: number, message: string, data?: unknown | undefined);
    static fromResponse(response: JSONRPCResponse): A2AError;
    isTaskNotFound(): boolean;
    isTaskNotCancelable(): boolean;
    isPushNotSupported(): boolean;
    isUnsupportedOperation(): boolean;
    isTimeout(): boolean;
}
export declare class AgentDiscoveryError extends Error {
    url: string;
    constructor(message: string, url: string);
}
export declare class TransportError extends Error {
    status?: number | undefined;
    url?: string | undefined;
    constructor(message: string, status?: number | undefined, url?: string | undefined);
}
