export type AutoScalerConfig = {
  cpuScaleUpThreshold: number; // 0.70
  cpuScaleDownThreshold: number; // 0.30
  pendingForScaleUpSeconds: number; // 180
  idleForScaleDownSeconds: number; // 600
  cooldownUpSeconds: number; // 300
  cooldownDownSeconds: number; // 600
  minWorkers: number; // 2
  maxWorkers: number;
};

export type Metrics = {
  avgCpu: number;
  pendingPods: number;
  pendingLongEnough: boolean;
  idleLongEnough: boolean;
  nowEpoch: number;
};
export type State = {
  scalingInProgress: boolean;
  lastScaleEpoch: number;
  workerCount: number;
  scaleUpActionId?: string;
};

export type Decision =
  | { type: "NOOP"; reason: string }
  | { type: "SCALE_UP"; reason: string; delta: number; lockKey: "cluster" }
  | {
      type: "SCALE_DOWN";
      reason: string;
      delta: number;
      lockKey: "cluster";
      toRemove: number;
    };

export function decide(cfg: AutoScalerConfig, m: Metrics, s: State): Decision {
  if (s.scalingInProgress)
    return { type: "NOOP", reason: "scalingInProgress=true" };

  let inCoolDown;

  if (s.scaleUpActionId) {
    inCoolDown = m.nowEpoch - s.lastScaleEpoch < cfg.cooldownUpSeconds;
  }

  if (!s.scaleUpActionId) {
    inCoolDown = m.nowEpoch - s.lastScaleEpoch < cfg.cooldownDownSeconds;
  }

  if (inCoolDown)
    return {
      type: "NOOP",
      reason: `cooldown active for scaling operation`,
    };

  const cpuUp = m.avgCpu > cfg.cpuScaleUpThreshold;
  const cpuDown = m.avgCpu <= cfg.cpuScaleDownThreshold;

  // Scale Up
  if (s.workerCount < cfg.maxWorkers && (cpuUp || m.pendingLongEnough)) {
    return {
      type: "SCALE_UP",
      reason: cpuUp ? "cpuHigh" : "pendingPods",
      delta: 1,
      lockKey: "cluster",
    };
  }

  // Scale down
  if (s.workerCount > cfg.minWorkers && cpuDown && m.idleLongEnough) {
    const redundantNodes = s.workerCount - cfg.minWorkers;
    const toRemove = Math.min(redundantNodes, 1);
    return {
      type: "SCALE_DOWN",
      reason: "cpuLowAndIdle",
      delta: 1,
      lockKey: "cluster",
      toRemove,
    };
  }

  return {
    type: "NOOP",
    reason: "stable and noConditionsMet",
  };
}
