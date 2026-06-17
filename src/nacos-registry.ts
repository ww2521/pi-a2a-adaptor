import * as http from "node:http";
import * as https from "node:https";
import type { NacosConfig, AgentSkill } from "./types.js";

// ─── Nacos A2A Registry API Types ───

interface NacosLoginResponse {
  accessToken: string;
  tokenTtl: number;
  globalAdmin: boolean;
}

interface NacosPageItem {
  protocolVersion?: string;
  name: string;
  description?: string;
  version: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills?: any[];
  registrationType?: string;
  url?: string;
  preferredTransport?: string;
}

interface NacosListResponse {
  code: number;
  message: string;
  data: {
    totalCount: number;
    pageNumber: number;
    pagesAvailable: number;
    pageItems: NacosPageItem[];
  };
}

interface NacosDetailResponse {
  code: number;
  message: string;
  data: {
    protocolVersion?: string;
    name: string;
    description: string;
    url?: string;
    preferredTransport?: string;
    version: string;
    capabilities?: {
      streaming?: boolean;
      pushNotifications?: boolean;
      stateTransitionHistory?: boolean;
    };
    skills?: AgentSkill[];
    defaultInputModes?: string[];
    defaultOutputModes?: string[];
    supportedInterfaces?: Array<{ protocolBinding: string; url: string }>;
  };
}

// ─── Nacos Registry Client ───

export class NacosRegistryClient {
  private config: NacosConfig;
  private accessToken: string | null = null;
  private tokenExpireAt: number = 0;

  constructor(config: NacosConfig) {
    this.config = config;
  }

  /** Update config (e.g. after /a2a-config change) */
  updateConfig(config: Partial<NacosConfig>): void {
    this.config = { ...this.config, ...config };
    // Reset token since credentials may have changed
    if (config.password !== undefined || config.username !== undefined || config.serverAddr !== undefined) {
      this.accessToken = null;
      this.tokenExpireAt = 0;
    }
  }

  /** Get current config (password masked) */
  getConfig(): NacosConfig {
    return { ...this.config };
  }

  // ─── Auth ───

  async getToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.tokenExpireAt) {
      return this.accessToken;
    }
    const url = `${this.config.serverAddr}/nacos/v3/auth/user/login`;
    const body = `username=${encodeURIComponent(this.config.username)}&password=${encodeURIComponent(this.config.password || "")}`;
    const res = await this.httpPostForm(url, body);
    const data = res as NacosLoginResponse;
    if (!data.accessToken) throw new Error(`Nacos login failed: ${JSON.stringify(res)}`);
    this.accessToken = data.accessToken;
    // Token TTL is in seconds, refresh 60s early
    this.tokenExpireAt = Date.now() + (data.tokenTtl - 60) * 1000;
    return this.accessToken;
  }

  // ─── List all AgentCards ───

  async listAgentCards(pageNo = 1, pageSize = 100): Promise<NacosPageItem[]> {
    const token = await this.getToken();
    const url = `${this.config.serverAddr}/nacos/v3/admin/ai/a2a/list?` +
      `pageNo=${pageNo}&pageSize=${pageSize}&namespaceId=${encodeURIComponent(this.config.namespaceId)}&agentName=&search=blur`;
    const res = await this.httpGet(url, token) as NacosListResponse;
    if (res.code !== 0) throw new Error(`Nacos list agents failed: ${res.message}`);
    return res.data.pageItems;
  }

  // ─── Get AgentCard details ───

  async getAgentCardDetail(agentName: string): Promise<NacosDetailResponse["data"]> {
    const token = await this.getToken();
    const url = `${this.config.serverAddr}/nacos/v3/admin/ai/a2a?` +
      `namespaceId=${encodeURIComponent(this.config.namespaceId)}&agentName=${encodeURIComponent(agentName)}`;
    const res = await this.httpGet(url, token) as NacosDetailResponse;
    if (res.code !== 0) throw new Error(`Nacos get agent detail failed: ${res.message}`);
    return res.data;
  }

  // ─── HTTP Helpers ───

  private httpMod(url: string): typeof http | typeof https {
    return new URL(url).protocol === "https:" ? https : http;
  }

  private async httpPostForm(url: string, body: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = this.httpMod(url).request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON from Nacos: ${data.slice(0, 200)}`)); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Nacos login timed out")); });
      req.write(body);
      req.end();
    });
  }

  private async httpGet(url: string, token: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = this.httpMod(url).request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "accessToken": token,
        },
        timeout: 15000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON from Nacos: ${data.slice(0, 200)}`)); }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }
}
