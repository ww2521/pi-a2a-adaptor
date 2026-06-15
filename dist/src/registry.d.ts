import type { A2AClient } from "./client.js";
import type { RemoteAgent } from "./types.js";
export declare class AgentRegistry {
    private registry;
    private cacheTtl;
    constructor(cacheTtl?: number);
    discover(client: A2AClient, url: string, force?: boolean): Promise<RemoteAgent>;
    lookup(ref: string): RemoteAgent | null;
    list(): RemoteAgent[];
    remove(url: string): boolean;
    clear(): void;
}
