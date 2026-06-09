import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { startContainer } from "./startup.js";

const REQUIRED_ENV = [
  "BRIDGE_AUTH_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "USER_ID",
  "DATA_BUCKET",
  "CALLBACK_URL",
] as const;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

interface TaskMetadata {
  taskArn: string;
  cluster: string;
}

async function getTaskMetadata(): Promise<TaskMetadata> {
  // Prefer env vars if set, otherwise discover from ECS metadata
  if (process.env.TASK_ARN && process.env.CLUSTER_ARN) {
    return { taskArn: process.env.TASK_ARN, cluster: process.env.CLUSTER_ARN };
  }
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadataUri) {
    const resp = await fetch(`${metadataUri}/task`);
    const data = (await resp.json()) as { TaskARN?: string; Cluster?: string };
    if (data.TaskARN && data.Cluster) {
      return { taskArn: data.TaskARN, cluster: data.Cluster };
    }
  }
  throw new Error("Cannot determine task metadata from env or ECS metadata");
}

async function main(): Promise<void> {
  // Validate required env vars
  const env = Object.fromEntries(REQUIRED_ENV.map((name) => [name, requireEnv(name)])) as Record<
    (typeof REQUIRED_ENV)[number],
    string
  >;

  const taskMetadata = await getTaskMetadata();

  // Initialize AWS clients
  const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamoSend = dynamoClient.send.bind(dynamoClient) as (cmd: any) => Promise<any>;
  const ecsClient = new ECSClient({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ecsSend = ecsClient.send.bind(ecsClient) as (cmd: any) => Promise<any>;
  const ec2Client = new EC2Client({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ec2Send = ec2Client.send.bind(ec2Client) as (cmd: any) => Promise<any>;

  await startContainer({
    env: {
      ...env,
      BRIDGE_TELEGRAM_TOKEN: process.env.BRIDGE_TELEGRAM_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    },
    taskMetadata,
    dynamoSend,
    ecsSend,
    ec2Send,
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
