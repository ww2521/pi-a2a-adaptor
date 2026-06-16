import type { A2AClient } from "./client.js";
import type { RemoteAgent, TaskOptions, A2ATask, TaskUpdateCallback } from "./types.js";
import type { AgentRegistry } from "./registry.js";

export class TaskManager {
  constructor(
    private client: A2AClient,
    private registry: AgentRegistry
  ) {}

  async sendTask(
    agent: RemoteAgent,
    message: string,
    options?: TaskOptions,
    onUpdate?: TaskUpdateCallback
  ): Promise<A2ATask> {
    if (onUpdate) {
      return this.client.sendStreamingMessage(
        agent,
        { role: "user", parts: [{ kind: "text", text: message }], messageId: this.genId() },
        onUpdate,
        options
      );
    }
    const result = await this.client.sendMessage(
      agent,
      { role: "user", parts: [{ kind: "text", text: message }], messageId: this.genId() },
      options
    );
    return this.asTask(result);
  }

  async sendParallelTasks(
    steps: Array<{ agent: RemoteAgent; message: string; options?: TaskOptions }>,
    onUpdate?: (update: Partial<A2ATask>, index: number) => void
  ): Promise<A2ATask[]> {
    return Promise.all(
      steps.map((step, i) =>
        this.sendTask(
          step.agent,
          step.message,
          step.options,
          onUpdate ? (u) => onUpdate(u, i) : undefined
        )
      )
    );
  }

  async sendChainTasks(
    steps: Array<{ agent: RemoteAgent; message: string; options?: TaskOptions }>,
    continueOnError = false
  ): Promise<A2ATask> {
    let previousOutput = "";

    for (let i = 0; i < steps.length; i++) {
      const { agent, message, options } = steps[i];
      const taskText = message.replace(/\{previous\}/g, previousOutput);

      let result: A2ATask;
      try {
        result = await this.sendTask(agent, taskText, options);
      } catch (err) {
        if (!continueOnError) throw err;
        // On error, pass error message as previous output
        previousOutput = `[Error in step ${i + 1}: ${err}]`;
        continue;
      }

      previousOutput = this.extractText(result);
    }

    // Return the last successful task, or throw if all failed
    const lastStep = steps[steps.length - 1];
    return await this.sendTask(lastStep.agent, previousOutput, lastStep.options);
  }

  private asTask(result: A2ATask | any): A2ATask {
    // Already a task
    if ((result as A2ATask).status) return result as A2ATask;
    // LiteLLM returns direct message: { kind: "message", role, parts, messageId }
    if ((result as any).role && (result as any).parts) {
      return {
        id: (result as any).taskId || (result as any).messageId || `msg-${Date.now()}`,
        contextId: (result as any).contextId || `ctx-${Date.now()}`,
        kind: "task",
        status: {
          state: "completed",
          timestamp: new Date().toISOString(),
          message: {
            kind: "message",
            role: (result as any).role,
            parts: (result as any).parts,
            messageId: (result as any).messageId || "",
          },
        },
        artifacts: [],
        metadata: {},
      } as A2ATask;
    }
    throw new Error(`Expected a task, got: ${JSON.stringify(result).slice(0, 200)}`);
  }

  private extractText(task: A2ATask): string {
    if (task.artifacts && task.artifacts.length > 0) {
      return task.artifacts[0].parts
        .filter((p) => p.kind === "text" && p.text)
        .map((p) => (p as any).text)
        .join("\n");
    }
    if (task.status?.message?.parts) {
      return task.status.message.parts
        .filter((p) => p.kind === "text" && p.text)
        .map((p) => (p as any).text)
        .join("\n");
    }
    return "";
  }

  private genId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
