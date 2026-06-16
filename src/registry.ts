import type { A2AClient } from "./client.js";
import type { RemoteAgent } from "./types.js";

interface CachedAgent {
  agent: RemoteAgent;
  cachedAt: number;
  lastVerified: number;
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
    this.registry.set(url, { agent: card, cachedAt: Date.now(), lastVerified: Date.now() });
    return card;
  }

  add(agent: RemoteAgent): void {
    this.registry.set(agent.url, { agent, cachedAt: Date.now(), lastVerified: Date.now() });
  }

  /**
   * Verify all agents in the registry by fetching their agent card.
   * Returns { ok: RemoteAgent[], stale: string[] } with URLs that failed.
   */
  async verifyAll(client: A2AClient, timeoutMs = 3000): Promise<{ ok: RemoteAgent[]; stale: string[] }> {
    const ok: RemoteAgent[] = [];
    const stale: string[] = [];
    const entries = [...this.registry.entries()];
    await Promise.all(entries.map(async ([url, entry]) => {
      try {
        const card = await client.discoverAgent(url);
        entry.agent = card;
        entry.lastVerified = Date.now();
        ok.push(card);
      } catch {
        stale.push(url);
      }
    }));
    // Remove stale agents
    for (const url of stale) this.registry.delete(url);
    return { ok, stale };
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
