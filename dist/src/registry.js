export class AgentRegistry {
    registry = new Map();
    cacheTtl;
    constructor(cacheTtl = 300000) {
        this.cacheTtl = cacheTtl;
    }
    async discover(client, url, force = false) {
        const cached = this.registry.get(url);
        if (cached && !force && Date.now() - cached.cachedAt < this.cacheTtl)
            return cached.agent;
        const card = await client.discoverAgent(url);
        this.registry.set(url, { agent: card, cachedAt: Date.now() });
        return card;
    }
    lookup(ref) {
        const cached = this.registry.get(ref);
        if (cached)
            return cached.agent;
        for (const [, entry] of this.registry) {
            if (entry.agent.name.toLowerCase() === ref.toLowerCase())
                return entry.agent;
        }
        return null;
    }
    list() { return Array.from(this.registry.values()).map((e) => e.agent); }
    remove(url) { return this.registry.delete(url); }
    clear() { this.registry.clear(); }
}
