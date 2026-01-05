export interface LockProvider {
  acquire(
    lockKey: string,
    owner: string,
    nowEpoch: number,
    ttlSeconds: number
  ): Promise<boolean>;

  release(
    lockKey: string,
    owner: string,
    nowEpoch: number,
    setLastScaleEpoch?: boolean
  ): Promise<void>;
}
