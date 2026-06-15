export class TaskManager {
    client;
    registry;
    constructor(client, registry) {
        this.client = client;
        this.registry = registry;
    }
    async sendTask(agent, message, options, onUpdate) {
        if (onUpdate) {
            return this.client.sendStreamingMessage(agent, { role: "user", parts: [{ kind: "text", text: message }], messageId: this.genId() }, onUpdate, options);
        }
        const result = await this.client.sendMessage(agent, { role: "user", parts: [{ kind: "text", text: message }], messageId: this.genId() }, options);
        return this.asTask(result);
    }
    async sendParallelTasks(steps, onUpdate) {
        return Promise.all(steps.map((step, i) => this.sendTask(step.agent, step.message, step.options, onUpdate ? (u) => onUpdate(u, i) : undefined)));
    }
    async sendChainTasks(steps, continueOnError = false) {
        let previousOutput = "";
        for (let i = 0; i < steps.length; i++) {
            const { agent, message, options } = steps[i];
            const taskText = message.replace(/\{previous\}/g, previousOutput);
            let result;
            try {
                result = await this.sendTask(agent, taskText, options);
            }
            catch (err) {
                if (!continueOnError)
                    throw err;
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
    asTask(result) {
        if (result.status)
            return result;
        throw new Error(`Expected a task, got: ${JSON.stringify(result).slice(0, 200)}`);
    }
    extractText(task) {
        if (task.artifacts && task.artifacts.length > 0) {
            return task.artifacts[0].parts
                .filter((p) => p.kind === "text" && p.text)
                .map((p) => p.text)
                .join("\n");
        }
        if (task.status?.message?.parts) {
            return task.status.message.parts
                .filter((p) => p.kind === "text" && p.text)
                .map((p) => p.text)
                .join("\n");
        }
        return "";
    }
    genId() {
        return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
}
