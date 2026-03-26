import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { saveConnection } from "../services/connections.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamoSend = ddb.send.bind(ddb) as (cmd: any) => Promise<any>;

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: "id",
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

export async function handler(event: {
  requestContext: { connectionId?: string };
  queryStringParameters?: Record<string, string>;
}): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  const token = event.queryStringParameters?.token;

  console.log("[ws-connect] connect", { connectionId });

  if (!token) {
    console.warn("[ws-connect] auth failed: missing token", { connectionId });
    return { statusCode: 401, body: JSON.stringify({ error: "Missing token" }) };
  }

  let userId: string;
  try {
    const payload = await verifier.verify(token);
    userId = payload.sub;
  } catch {
    console.warn("[ws-connect] auth failed: invalid token", { connectionId });
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid token" }) };
  }

  await saveConnection(dynamoSend, connectionId!, userId);

  console.log("[ws-connect] connected", { connectionId, userId });
  return { statusCode: 200, body: "Connected" };
}
