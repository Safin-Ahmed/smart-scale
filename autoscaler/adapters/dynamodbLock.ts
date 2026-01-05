import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { LockProvider } from "./lock";

/**
 * Distributed lock stored in the SAME table but a DIFFERENT item:
 *  - state item: pk = "cluster"
 *  - lock item:  pk = "lock#cluster"
 *
 * This prevents lock operations from corrupting state attributes.
 */
export class DynamoDbLockProvider implements LockProvider {
  private ddb = new DynamoDBClient({});

  constructor(private tableName: string) {}

  private lockPk(lockKey: string) {
    return `lock#${lockKey}`;
  }

  async acquire(
    lockKey: string,
    owner: string,
    nowEpoch: number,
    ttlSeconds: number
  ): Promise<boolean> {
    const lockUntil = nowEpoch + ttlSeconds;

    try {
      await this.ddb.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: { pk: { S: this.lockPk(lockKey) } },
          UpdateExpression: "SET lockHeld=:t, lockOwner=:o, lockUntilEpoch=:u",
          ConditionExpression:
            "attribute_not_exists(lockHeld) OR lockHeld=:f OR lockUntilEpoch < :now",
          ExpressionAttributeValues: {
            ":t": { BOOL: true },
            ":f": { BOOL: false },
            ":o": { S: owner },
            ":u": { N: String(lockUntil) },
            ":now": { N: String(nowEpoch) },
          },
        })
      );

      return true;
    } catch (e: any) {
      if (e?.name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }

  async release(
    lockKey: string,
    owner: string,
    _nowEpoch: number,
    _setLastScaleEpoch = false // ignore; we do NOT update lastScaleEpoch in lock anymore
  ): Promise<void> {
    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: { S: this.lockPk(lockKey) } },
        UpdateExpression:
          "SET lockHeld=:f, lockOwner=:empty, lockUntilEpoch=:zero",
        ConditionExpression: "lockOwner = :o",
        ExpressionAttributeValues: {
          ":f": { BOOL: false },
          ":empty": { S: "" },
          ":zero": { N: "0" },
          ":o": { S: owner },
        },
      })
    );
  }
}
