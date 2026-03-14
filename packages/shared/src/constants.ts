// DynamoDB Table Names
export const TABLE_NAMES = {
  CONVERSATIONS: "serverless-openclaw-Conversations",
  SETTINGS: "serverless-openclaw-Settings",
  TASK_STATE: "serverless-openclaw-TaskState",
  CONNECTIONS: "serverless-openclaw-Connections",
  PENDING_MESSAGES: "serverless-openclaw-PendingMessages",
} as const;

// DynamoDB Key Prefixes
export const KEY_PREFIX = {
  USER: "USER#",
  CONV: "CONV#",
  MSG: "MSG#",
  SETTING: "SETTING#",
  CONN: "CONN#",
} as const;

// Ports
export const BRIDGE_PORT = 8080;
export const BRIDGE_HTTP_TIMEOUT_MS = 3000;
export const GATEWAY_PORT = 18789;

// Timeouts (ms)
export const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
export const PENDING_MESSAGE_TTL_SEC = 5 * 60;
export const CONNECTION_TTL_SEC = 24 * 60 * 60;
export const PERIODIC_BACKUP_INTERVAL_MS = 5 * 60 * 1000;

// Identity Linking (OTP)
export const OTP_TTL_SEC = 300;
export const OTP_LENGTH = 6;

// Watchdog
export const WATCHDOG_INTERVAL_MINUTES = 5;
export const MIN_UPTIME_MINUTES = 5;

// Session S3 paths (shared between Lambda and Fargate)
export const SESSION_S3_PREFIX = "sessions";
export const SESSION_DEFAULT_AGENT = "default";
export const SESSION_DEFAULT_KEY = "main";

// Prewarm
export const PREWARM_USER_ID = "system:prewarm";
export const DEFAULT_PREWARM_DURATION_MIN = 60;

// Dynamic Timeout
export const ACTIVE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — active hours
export const INACTIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — inactive hours
export const ACTIVITY_LOOKBACK_DAYS = 7;
export const ACTIVE_HOUR_THRESHOLD = 2; // >= 2 days with activity at this hour
export const METRICS_NAMESPACE = "ServerlessOpenClaw";
