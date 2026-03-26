import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { deleteConnection } from "../services/connections.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamoSend = ddb.send.bind(ddb) as (cmd: any) => Promise<any>;

export async function handler(event: {
  requestContext: { connectionId?: string };
}): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId!;

  console.log("[ws-disconnect] disconnect", { connectionId });
  await deleteConnection(dynamoSend, connectionId);

  return { statusCode: 200, body: "Disconnected" };
}
