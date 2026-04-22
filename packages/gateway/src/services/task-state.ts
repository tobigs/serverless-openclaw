import { GetCommand, PutCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAMES, KEY_PREFIX } from "@serverless-openclaw/shared";
import type { TaskStateItem } from "@serverless-openclaw/shared";

type Send = (command: unknown) => Promise<unknown>;

export async function getTaskState(send: Send, userId: string): Promise<TaskStateItem | null> {
  const result = (await send(
    new GetCommand({
      TableName: TABLE_NAMES.TASK_STATE,
      Key: { PK: `${KEY_PREFIX.USER}${userId}` },
    }),
  )) as { Item?: TaskStateItem };

  const item = result.Item;
  if (!item || item.status === "Idle") return null;
  return item;
}

export async function putTaskState(send: Send, item: TaskStateItem): Promise<void> {
  await send(
    new PutCommand({
      TableName: TABLE_NAMES.TASK_STATE,
      Item: item,
    }),
  );
}

export async function deleteTaskState(send: Send, userId: string): Promise<void> {
  await send(
    new DeleteCommand({
      TableName: TABLE_NAMES.TASK_STATE,
      Key: { PK: `${KEY_PREFIX.USER}${userId}` },
    }),
  );
}

/**
 * Atomically refresh `lastActivity` on an existing TaskState row.
 * Uses UpdateCommand (single-attribute) to avoid clobbering concurrent writes
 * from the container (e.g. `updateTaskState("Running", publicIp)` at boot).
 */
export async function updateLastActivity(send: Send, userId: string): Promise<void> {
  await send(
    new UpdateCommand({
      TableName: TABLE_NAMES.TASK_STATE,
      Key: { PK: `${KEY_PREFIX.USER}${userId}` },
      UpdateExpression: "SET lastActivity = :la",
      ExpressionAttributeValues: { ":la": new Date().toISOString() },
    }),
  );
}
