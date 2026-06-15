// === Task State ===
export type TaskStatus = "Idle" | "Starting" | "Running" | "Stopping";

// === WebSocket Message Protocol (architecture.md §6.1) ===
export interface ClientMessage {
  action: "sendMessage" | "getHistory" | "getStatus";
  conversationId?: string;
  message?: string;
}

export type ServerMessageType = "message" | "status" | "error" | "stream_chunk" | "stream_end";

export interface ServerMessage {
  type: ServerMessageType;
  conversationId?: string;
  content?: string;
  status?: TaskStatus | "idle" | "starting" | "running" | "stopping";
  error?: string;
}

// === Channel ===
export type Channel = "web" | "telegram";

// === DynamoDB Items (architecture.md §5) ===
export interface ConversationItem {
  PK: string; // USER#{userId}
  SK: string; // CONV#{conversationId}#MSG#{timestamp}
  role: "user" | "assistant" | "system";
  content: string;
  channel: Channel;
  metadata?: Record<string, unknown>;
  ttl?: number;
}

export interface SettingsItem {
  PK: string; // USER#{userId}
  SK: string; // SETTING#{key}
  value: string | Record<string, unknown>;
  updatedAt: string;
}

export interface TaskStateItem {
  PK: string; // USER#{userId}
  taskArn: string;
  status: TaskStatus;
  publicIp?: string;
  startedAt: string;
  lastActivity: string;
  ttl?: number;
  prewarmUntil?: number; // Unix timestamp (ms). Watchdog skips if now < this.
}

export interface ConnectionItem {
  PK: string; // CONN#{connectionId}
  userId: string;
  connectedAt: string;
  ttl?: number;
}

export interface PendingMessageItem {
  PK: string; // USER#{userId}
  SK: string; // MSG#{timestamp}#{uuid}
  message: string;
  channel: Channel;
  connectionId: string;
  createdAt: string;
  ttl: number;
}

// === Bridge API ===
export interface BridgeMessageRequest {
  userId: string;
  message: string;
  channel: Channel;
  connectionId: string;
  callbackUrl: string;
}

export interface BridgeHealthResponse {
  status: "ok";
}

// === Lambda Agent ===
export interface LambdaAgentEvent {
  userId: string;
  sessionId: string;
  connectionId?: string;
  message: string;
  model?: string;
  disableTools?: boolean;
  channel: Channel;
  telegramChatId?: string;
}

export interface LambdaAgentResponse {
  success: boolean;
  payloads?: Array<{ text?: string; mediaUrl?: string; isError?: boolean }>;
  error?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
}

// === JSON-RPC 2.0 (implementation-plan.md §2.2) ===
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number;
}
