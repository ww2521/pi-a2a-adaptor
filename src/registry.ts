import type { A2AClient } from "./client.js";
import type { RemoteAgent } from "./types.js";

interface CachedAgent {
  agent: RemoteAgent;
  cachedAt: number;
}

export class AgentRegistry {
  private registry = new Map<string, CachedAgent>();
  private cacheTtl: number;

  constructor(cacheTtl = 300000) {
    this.cacheTtl = cacheTtl;
  }

  async discover(client: A2AClient, url: string, force = false): Promise<RemoteAgent> {
    const cached = this.registry.get(url);
    if (cached && !force && Date.now() - cached.cachedAt < this.cacheTtl) return cached.agent;
    const card = await client.discoverAgent(url);
    this.registry.set(url, { agent: card, cachedAt: Date.now() });
    return card;
  }

  add(agent: RemoteAgent): void {
    this.registry.set(agent.url, { agent, cachedAt: Date.now() });
  }

  lookup(ref: string): RemoteAgent | null {
    const cached = this.registry.get(ref);
    if (cached) return cached.agent;
    for (const [, entry] of this.registry) {
      if (entry.agent.name.toLowerCase() === ref.toLowerCase()) return entry.agent;
    }
    return null;
  }

  list(): RemoteAgent[] { return Array.from(this.registry.values()).map((e) => e.agent); }
  remove(url: string): boolean { return this.registry.delete(url); }
  clear(): void { this.registry.clear(); }
}
