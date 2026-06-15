import type { A2AClient } from "./client.js";
import type { RemoteAgent, TaskOptions, A2ATask, TaskUpdateCallback } from "./types.js";
import type { AgentRegistry } from "./registry.js";
export declare class TaskManager {
    private client;
    private registry;
    constructor(client: A2AClient, registry: AgentRegistry);
    sendTask(agent: RemoteAgent, message: string, options?: TaskOptions, onUpdate?: TaskUpdateCallback): Promise<A2ATask>;
    sendParallelTasks(steps: Array<{
        agent: RemoteAgent;
        message: string;
        options?: TaskOptions;
    }>, onUpdate?: (update: Partial<A2ATask>, index: number) => void): Promise<A2ATask[]>;
    sendChainTasks(steps: Array<{
        agent: RemoteAgent;
        message: string;
        options?: TaskOptions;
    }>, continueOnError?: boolean): Promise<A2ATask>;
    private asTask;
    private extractText;
    private genId;
}
