declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event?: unknown, ctx?: any) => void | Promise<void>): void;
    registerCommand(name: string, spec: { description?: string; handler: (args: string, ctx: any) => void | Promise<void> }): void;
    registerTool(spec: { name: string; label?: string; description?: string; parameters?: unknown; execute: (toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> }): void;
  }
  export interface ExtensionContext {}
}
