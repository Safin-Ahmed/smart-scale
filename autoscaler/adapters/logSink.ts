import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

export async function writeLog(params: {
  tableName: string;
  clusterKey?: string;
  requestId: string;
  nowEpoch: number;
  payload: Record<string, any>;
}) {
  const pk = params.clusterKey ?? "cluster";
  const iso = new Date(params.nowEpoch * 1000).toISOString();
  const sk = `${iso}#${params.requestId}`;

  await ddb.send(
    new PutItemCommand({
      TableName: params.tableName,
      Item: {
        pk: { S: pk },
        sk: { S: sk },
        tsEpoch: { N: String(params.nowEpoch) },
        requestId: { S: params.requestId },
        payload: { S: JSON.stringify(params.payload) },
      },
    })
  );
}
