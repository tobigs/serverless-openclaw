export const SSM_PARAMS = {
  TASK_DEFINITION_ARN: "/serverless-openclaw/compute/task-definition-arn",
  TASK_ROLE_ARN: "/serverless-openclaw/compute/task-role-arn",
  EXECUTION_ROLE_ARN: "/serverless-openclaw/compute/execution-role-arn",
  CLUSTER_ARN: "/serverless-openclaw/compute/cluster-arn",
  LAMBDA_AGENT_FUNCTION_ARN: "/serverless-openclaw/lambda-agent/function-arn",
} as const;

export const MCP_SECRETS_PATH_PREFIX = "/serverless-openclaw/mcp-secrets";

export const SSM_SECRETS = {
  BRIDGE_AUTH_TOKEN: "/serverless-openclaw/secrets/bridge-auth-token",
  OPENCLAW_GATEWAY_TOKEN: "/serverless-openclaw/secrets/openclaw-gateway-token",
  ANTHROPIC_API_KEY: "/serverless-openclaw/secrets/anthropic-api-key",
  TELEGRAM_BOT_TOKEN: "/serverless-openclaw/secrets/telegram-bot-token",
  TELEGRAM_WEBHOOK_SECRET: "/serverless-openclaw/secrets/telegram-webhook-secret",
} as const;
