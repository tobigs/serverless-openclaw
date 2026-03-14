import type { TaskStateItem } from "@serverless-openclaw/shared";

export type RouteDecision = "lambda" | "fargate-reuse" | "fargate-new";

export interface ClassifyRouteParams {
  message: string;
  taskState: TaskStateItem | null;
}

const FARGATE_HINTS = ["/heavy", "/fargate"];

/**
 * Classify which runtime to use for a message when AGENT_RUNTIME=both.
 * Priority: 1) Reuse running Fargate, 2) User hint, 3) Default Lambda
 */
export function classifyRoute(params: ClassifyRouteParams): RouteDecision {
  // Rule 1: Reuse running Fargate container (don't waste it)
  if (params.taskState?.status === "Running" && params.taskState.publicIp) {
    return "fargate-reuse";
  }

  // Rule 2: User explicitly requests Fargate
  const lowerMsg = params.message.trimStart().toLowerCase();
  for (const hint of FARGATE_HINTS) {
    if (lowerMsg.startsWith(hint)) {
      return "fargate-new";
    }
  }

  // Rule 3: Default to Lambda
  return "lambda";
}

/**
 * Strip Fargate hint prefix from message if present.
 * Returns the original message if no hint found.
 */
export function stripRouteHint(message: string): string {
  const trimmed = message.trimStart();
  const lower = trimmed.toLowerCase();
  for (const hint of FARGATE_HINTS) {
    if (lower.startsWith(hint)) {
      return trimmed.slice(hint.length).trimStart();
    }
  }
  return message;
}
