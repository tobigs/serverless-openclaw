export type {
  LambdaAgentEvent,
  LambdaAgentResponse,
} from "@serverless-openclaw/shared";

export interface AgentPayload {
  text?: string;
  mediaUrl?: string;
  isError?: boolean;
}

export interface ConfigInitResult {
  configDir: string;
  sessionsDir: string;
}
