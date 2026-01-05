import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient();

export type StateRecord = {
  scalingInProgress: boolean;
  lastScaleEpoch: number;

  pendingSinceEpoch: number;
  idleSinceEpoch: number;
  workerCount: number;

  scaleUpActionId?: string;
  scaleUpStartedEpoch?: number;
  scaleUpInstanceIds?: string[];
};

export async function ensureState(tableName: string): Promise<void> {
  // Create if missing
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: "cluster" },
          scalingInProgress: { BOOL: false },
          lastScaleEpoch: { N: "0" },
          pendingSinceEpoch: { N: "0" },
          idleSinceEpoch: { N: "0" },
          workerCount: { N: "0" },
          scaleUpStartedEpoch: { N: "0" },
          scaleUpInstanceIds: { L: [] },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
  } catch (err) {}
}

export async function loadState(tableName: string): Promise<StateRecord> {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: "cluster" } },
      ConsistentRead: true,
    })
  );

  const it = res.Item;

  if (!it)
    throw new Error("State item missing. Did you create the dynamo db record?");

  const instanceIds = it.scaleUpInstanceIds?.L?.map((x) => x.S).filter(
    Boolean
  ) as string[] | undefined;

  return {
    scalingInProgress: it.scalingInProgress?.BOOL ?? false,
    lastScaleEpoch: Number(it.lastScaleEpoch?.N ?? "0"),
    pendingSinceEpoch: Number(it.pendingSinceEpoch?.N ?? "0"),
    idleSinceEpoch: Number(it.idleSinceEpoch?.N ?? "0"),
    workerCount: Number(it.workerCount?.N ?? "0"),
    scaleUpActionId: it.scaleUpActionId?.S,
    scaleUpStartedEpoch: it.scaleUpStartedEpoch
      ? Number(it.scaleUpStartedEpoch.N ?? "0")
      : undefined,
    scaleUpInstanceIds:
      instanceIds && instanceIds.length ? instanceIds : undefined,
  };
}

export async function updateTiming(
  tableName: string,
  pendingSinceEpoch: number,
  idleSinceEpoch: number,
  workerCount: number
) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: "cluster" } },
      UpdateExpression:
        "SET pendingSinceEpoch=:p, idleSinceEpoch=:i, workerCount=:w",
      ExpressionAttributeValues: {
        ":p": { N: String(pendingSinceEpoch) },
        ":i": { N: String(idleSinceEpoch) },
        ":w": { N: String(workerCount) },
      },
    })
  );
}

/**
 *  Begin a scale-up action.
 * This is the important part: it uses a conditional write so only one scale-up can start.
 */
export async function beginScaleUp(params: {
  tableName: string;
  nowEpoch: number;
  actionId: string;
  requested: number; // 1-2
}) {
  const { tableName, nowEpoch, actionId, requested } = params;

  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: "cluster" } },
      UpdateExpression:
        "SET scalingInProgress=:t, scaleUpActionId=:aid, scaleUpStartedEpoch=:now, scaleUpRequested=:req, scaleUpInstanceIds=:empty",
      ConditionExpression:
        "attribute_not_exists(scalingInProgress) OR scalingInProgress=:f",
      ExpressionAttributeValues: {
        ":t": { BOOL: true },
        ":f": { BOOL: false },
        ":aid": { S: actionId },
        ":now": { N: String(nowEpoch) },
        ":req": { N: String(requested) },
        ":empty": { L: [] },
      },
    })
  );
}

/**
 * Record launched instance IDs for the current scale-up action.
 * Condition prevents overwriting if actionId doesn't match.
 */
export async function recordScaleUpInstances(params: {
  tableName: string;
  actionId: string;
  instanceIds: string[];
}) {
  const { tableName, actionId, instanceIds } = params;

  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: "cluster" } },
      UpdateExpression: "SET scaleUpInstanceIds=:ids",
      ConditionExpression: "scaleUpActionId=:aid",
      ExpressionAttributeValues: {
        ":aid": { S: actionId },
        ":ids": { L: instanceIds.map((id) => ({ S: id })) },
      },
    })
  );
}

/**
 * Complete scale-up ONLY after verification (nodes Ready).
 * We set lastScaleEpoch here, not at launch time.
 */
export async function completeScaleUp(params: {
  tableName: string;
  actionId: string;
  nowEpoch: number;
}) {
  const { tableName, actionId, nowEpoch } = params;

  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: "cluster" } },
      UpdateExpression:
        "SET scalingInProgress=:f, lastScaleEpoch=:now REMOVE scaleUpActionId, scaleUpStartedEpoch, scaleUpRequested, scaleUpInstanceIds",
      ConditionExpression: "scaleUpActionId=:aid",
      ExpressionAttributeValues: {
        ":f": { BOOL: false },
        ":now": { N: String(nowEpoch) },
        ":aid": { S: actionId },
      },
    })
  );
}

/**
 * Fail/clear a stuck scale-up after JOIN_TIMEOUT.
 * This lets your system recover instead of being stuck "scalingInProgress=true" forever.
 */
export async function failScaleUp(params: {
  tableName: string;
  actionId: string;
}) {
  const { tableName, actionId } = params;

  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: "cluster" } },
      UpdateExpression:
        "SET scalingInProgress=:f REMOVE scaleUpActionId, scaleUpStartedEpoch, scaleUpRequested, scaleUpInstanceIds",
      ConditionExpression: "scaleUpActionId=:aid",
      ExpressionAttributeValues: {
        ":f": { BOOL: false },
        ":aid": { S: actionId },
      },
    })
  );
}

export async function recordScaleDown(tableName: string, nowEpoch: number) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: "cluster" } },
      UpdateExpression: "SET lastScaleEpoch = :now, scalingInProgress = :false",
      ExpressionAttributeValues: {
        ":now": { N: String(nowEpoch) },
        ":false": { BOOL: false },
      },
    })
  );
}
