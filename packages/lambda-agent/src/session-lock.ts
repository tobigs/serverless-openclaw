import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { TABLE_NAMES, KEY_PREFIX } from "@serverless-openclaw/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class SessionLock {
  private readonly userId: string;
  private readonly executionId: string;

  constructor(userId: string) {
    this.userId = userId;
    this.executionId = `lambda-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Acquire lock. Returns true if acquired, false if another execution holds it. */
  async acquire(): Promise<boolean> {
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAMES.TASK_STATE,
          Item: {
            PK: `${KEY_PREFIX.USER}${this.userId}`,
            taskArn: this.executionId,
            status: "Running",
            startedAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 900, // 15 min TTL (Lambda max)
          },
          ConditionExpression: "attribute_not_exists(PK) OR #s <> :running",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":running": "Running" },
        }),
      );
      return true;
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw err;
    }
  }

  /** Release lock. Safe to call multiple times. */
  async release(): Promise<void> {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE_NAMES.TASK_STATE,
          Key: { PK: `${KEY_PREFIX.USER}${this.userId}` },
          ConditionExpression: "taskArn = :eid",
          ExpressionAttributeValues: { ":eid": this.executionId },
        }),
      );
    } catch {
      // Lock already released or claimed by another execution — safe to ignore
    }
  }
}
