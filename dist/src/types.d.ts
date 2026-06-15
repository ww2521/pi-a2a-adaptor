export type Part = TextPart | FilePart | DataPart;
export interface TextPart {
    kind: "text";
    text: string;
    metadata?: Record<string, unknown>;
}
export interface FilePart {
    kind: "file";
    file: FileWithBytes | FileWithUri;
    metadata?: Record<string, unknown>;
}
export interface FileWithBytes {
    bytes: string;
    mimeType?: string;
}
export interface FileWithUri {
    uri: string;
    mimeType?: string;
}
export interface DataPart {
    kind: "data";
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface Message {
    role: "user" | "agent";
    parts: Part[];
    kind?: "message";
    metadata?: Record<string, unknown>;
    messageId: string;
    contextId?: string;
    taskId?: string;
    referenceTaskIds?: string[];
    extensions?: string[];
}
export type TaskState = "submitted" | "working" | "inputRequired" | "authRequired" | "completed" | "failed" | "canceled" | "rejected";
export interface TaskStatus {
    state: TaskState;
    message?: Message;
    timestamp?: string;
}
export interface Artifact {
    artifactId: string;
    name?: string;
    description?: string;
    parts: Part[];
    metadata?: Record<string, unknown>;
    extensions?: string[];
}
export interface A2ATask {
    id: string;
    contextId: string;
    kind: "task";
    status: TaskStatus;
    history?: Message[];
    artifacts?: Artifact[];
    metadata?: Record<string, unknown>;
}
export interface JSONRPCResponse {
    jsonrpc: "2.0";
    id: string | number;
    result?: StreamResult;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export type StreamResult = {
    kind: "task";
    task: A2ATask;
} | {
    kind: "message";
    message: Message;
} | {
    kind: "status-update";
    taskId: string;
    contextId: string;
    status: TaskStatus;
    final: boolean;
    metadata?: Record<string, unknown>;
} | {
    kind: "artifact-update";
    taskId: string;
    contextId: string;
    artifact: Artifact;
    append?: boolean;
    lastChunk?: boolean;
    metadata?: Record<string, unknown>;
};
export interface JSONRPCRequest {
    jsonrpc: "2.0";
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}
export interface PushNotificationConfig {
    id?: string;
    url: string;
    token?: string;
    authentication?: {
        scheme: string;
        credentials?: string;
    };
}
export interface MessageSendConfiguration {
    acceptedOutputModes: string[];
    blocking?: boolean;
    historyLength?: number;
    pushNotificationConfig?: PushNotificationConfig;
}
export interface MessageSendParams {
    message: Message;
    configuration?: MessageSendConfiguration;
    tenant?: string;
    metadata?: Record<string, unknown>;
}
export interface TaskQueryParams {
    id: string;
    historyLength?: number;
    tenant?: string;
    metadata?: Record<string, unknown>;
}
export interface TaskIdParams {
    id: string;
    tenant?: string;
    metadata?: Record<string, unknown>;
}
export interface ListTasksParams {
    contextId?: string;
    status?: TaskState;
    statusTimestampAfter?: string;
    historyLength?: number;
    includeArtifacts?: boolean;
    pageSize?: number;
    pageToken?: string;
    tenant?: string;
}
export interface ListTasksResult {
    tasks: A2ATask[];
    nextPageToken?: string;
    pageSize?: number;
    totalSize?: number;
}
export interface AgentInterface {
    protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON" | string;
    url: string;
    protocolVersion?: string;
    tenant?: string;
}
export interface AgentCapabilities {
    streaming?: boolean;
    pushNotifications?: boolean;
    extendedAgentCard?: boolean;
    extensions?: AgentExtension[];
}
export interface AgentExtension {
    uri: string;
    description?: string;
    required?: boolean;
    params?: Record<string, unknown>;
}
export interface AgentProvider {
    organization: string;
    url?: string;
}
export interface AgentSkill {
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
    inputModes?: string[];
    outputModes?: string[];
    securityRequirements?: SecurityRequirement[];
}
export interface AgentCardSignature {
    protected: string;
    signature: string;
    header?: Record<string, unknown>;
}
export interface AgentCard {
    name: string;
    description: string;
    version: string;
    url?: string;
    provider?: AgentProvider;
    documentationUrl?: string;
    iconUrl?: string;
    supportedInterfaces?: AgentInterface[];
    capabilities: AgentCapabilities;
    securitySchemes?: Record<string, SecurityScheme>;
    securityRequirements?: SecurityRequirement[];
    defaultInputModes: string[];
    defaultOutputModes: string[];
    skills: AgentSkill[];
    signatures?: AgentCardSignature[];
}
export interface SecurityScheme {
    httpAuthSecurityScheme?: {
        scheme: string;
        bearerFormat?: string;
        description?: string;
    };
    apiKeySecurityScheme?: {
        name: string;
        location: string;
        description?: string;
    };
    oauth2SecurityScheme?: {
        flows: Record<string, unknown>;
        oauth2MetadataUrl?: string;
        description?: string;
    };
    openIdConnectSecurityScheme?: {
        openIdConnectUrl: string;
        description?: string;
    };
    mtlsSecurityScheme?: {
        description?: string;
    };
}
export interface SecurityRequirement {
    schemes: Record<string, string[]>;
}
export interface A2AClientOptions {
    protocol?: "a2a-v1" | "pi-legacy";
}
export interface A2AConfig {
    client: ClientConfig;
    server: ServerConfig;
    discovery: DiscoveryConfig;
    security: SecurityConfig;
}
export interface ServerConfig {
    enabled: boolean;
    port: number;
    host: string;
    basePath: string;
}
export interface ClientConfig {
    timeout: number;
    retryAttempts: number;
    retryDelay: number;
    maxConcurrentTasks: number;
    streamingEnabled: boolean;
}
export interface DiscoveryConfig {
    cacheEnabled: boolean;
    cacheTtl: number;
    agentCardPath: string;
}
export interface A2AConfig {
    client: ClientConfig;
    server: ServerConfig;
    discovery: DiscoveryConfig;
    security: SecurityConfig;
}
export interface SecurityConfig {
    defaultScheme: "bearer" | "apiKey" | "oauth2" | "mtls" | "none";
    verifySsl: boolean;
    apiKey?: string;
    bearerToken?: string;
    oauth2Config?: {
        clientId: string;
        clientSecret: string;
        tokenUrl: string;
        scopes: string[];
    };
    mtlsConfig?: {
        cert: string;
        key: string;
        ca?: string;
    };
}
export interface PollingOptions {
    intervalMs: number;
    maxAttempts: number;
    timeoutMs: number;
}
export interface TaskOptions {
    streaming?: boolean;
    timeout?: number;
    signal?: AbortSignal;
    historyLength?: number;
    blocking?: boolean;
    acceptedOutputModes?: string[];
    pushNotificationConfig?: PushNotificationConfig;
    polling?: PollingOptions;
    metadata?: Record<string, unknown>;
}
export interface RemoteAgent {
    name: string;
    description: string;
    url: string;
    version: string;
    supportedInterfaces?: AgentInterface[];
    capabilities: AgentCapabilities;
    skills: AgentSkill[];
    defaultInputModes: string[];
    defaultOutputModes: string[];
    discoveredAt: number;
    lastUsedAt?: number;
    healthStatus?: "healthy" | "unhealthy" | "unknown";
    healthCheckedAt?: number;
}
export type TaskUpdateCallback = (update: Partial<A2ATask>) => void;
export declare enum JSONRPCErrorCode {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
    TaskNotFound = -32001,
    TaskNotCancelable = -32002,
    PushNotificationNotSupported = -32003,
    UnsupportedOperation = -32004,
    ContentTypeNotSupported = -32005,
    InvalidAgentResponse = -32006,
    TaskTimeout = -32007
}
