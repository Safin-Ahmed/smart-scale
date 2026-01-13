import { decide, AutoScalerConfig } from "../core/decision";
import { getMetrics, getReadyNodeIps } from "../adapters/prometheus";
import axios from "axios";
import * as https from "https";
import {
  listRunningWorkers,
  findMasterPrivateIp,
  launchWorkers,
  getPrivateIpsForInstanceIds,
  terminateInstances,
  describeSubnetsAz,
} from "../adapters/ec2";
import {
  beginScaleUp,
  completeScaleUp,
  ensureState,
  failScaleUp,
  loadState,
  recordScaleUpInstances,
  beginScaleDown,
  markScaleDownInstanceDone,
  completeScaleDown,
  failScaleDown,
} from "../adapters/state";
import { DynamoDbLockProvider } from "../adapters/dynamodbLock";
import { writeLog } from "../adapters/logSink";
import { runShellOnInstance } from "../adapters/ssm";
import getSecureParam from "../adapters/ssm-parameter-store";

export const handler = async (event: any, context: any) => {
  const tableName = mustEnv("STATE_TABLE");
  const lock = new DynamoDbLockProvider(tableName);
  const logsTable = mustEnv("LOGS_TABLE");

  const apiTokenParamName = process.env.K8S_API_TOKEN_PARAM!;
  const clusterTokenParamName = process.env.K3S_CLUSTER_TOKEN_PARAM!;

  const k8sApiToken = await getSecureParam(apiTokenParamName);
  const clusterToken = await getSecureParam(clusterTokenParamName);

  const now = Math.floor(Date.now() / 1000);
  const owner = context?.awsRequestId ?? `local=${now}`;

  const promNodePort = process.env.PROM_NODEPORT ?? "30900";

  const workerTagKey = process.env.WORKER_TAG_KEY ?? "Role";
  const workerTagValue = process.env.WORKER_TAG_VALUE ?? "k3s-worker";

  const detailType = event?.["detail-type"];

  if (
    detailType === "EC2 Spot Instance Interruption Warning" ||
    detailType === "EC2 Instance Rebalance Recommendation"
  ) {
    return await handleSpotEvent(event, {
      tableName,
      logsTable,
      lock,
      owner,
      now,
      k8sApiToken,
      clusterToken,
      workerTagKey,
      workerTagValue,
      promNodePort,
    });
  }

  const cfg: AutoScalerConfig = {
    cpuScaleUpThreshold: Number(process.env.CPU_UP ?? "0.70"),
    cpuScaleDownThreshold: Number(process.env.CPU_DOWN ?? "0.30"),
    pendingForScaleUpSeconds: Number(process.env.PENDING_UP_SEC ?? "180"),
    idleForScaleDownSeconds: Number(process.env.IDLE_DOWN_SEC ?? "600"),
    cooldownUpSeconds: Number(process.env.COOLDOWN_UP_SEC ?? "300"),
    cooldownDownSeconds: Number(process.env.COOLDOWN_DOWN_SEC ?? "600"),
    minWorkers: Number(process.env.MIN_WORKERS ?? "2"),
    maxWorkers: Number(process.env.MAX_WORKERS ?? "10"),
  };

  const cooldownUpSec = Number(process.env.COOLDOWN_UP_SEC ?? "300"); // 5m
  const joinTimeoutSec = Number(process.env.JOIN_TIMEOUT_SEC ?? "600"); // 10m

  // Ensure Dynamo State exists
  await ensureState(tableName);

  // Load state and update timestamps
  let s = await loadState(tableName);

  // Determine Prometheus endpoint (pick a worker private ip)

  const masterIp = await findMasterPrivateIp();

  const prometheusBaseURL = `http://${masterIp}:${promNodePort}`;

  // PHASE 2: VERIFY JOIN MODE
  if (s.scalingInProgress && s.scaleUpActionId) {
    const age = now - (s.scaleUpStartedEpoch ?? now);

    // Verify via SSM on master: instance private IPs must appear Ready in k8s

    if (s.scaleUpInstanceIds?.length) {
      try {
        // 1. Get Private IPs of the instances we just launched
        const launchedPairs = await getPrivateIpsForInstanceIds(
          s.scaleUpInstanceIds
        );
        const wantedIps = launchedPairs.map((p) => p.ip);

        // 2. Get the IPs Prometheus currently sees as joined
        const readyIps = await getReadyNodeIps(prometheusBaseURL);

        // Normalize both lists: trim whitespace and convert to lowercase
        const normalizedReadyIps = readyIps.map((ip) =>
          ip.trim().toLowerCase()
        );

        // 3. Compare
        const missingIps = wantedIps.filter((wantedIp) => {
          const normalizedWanted = wantedIp.trim().toLowerCase();
          return !normalizedReadyIps.includes(normalizedWanted);
        });

        await writeLog({
          tableName: logsTable,
          requestId: owner,
          nowEpoch: now,
          payload: {
            phase: "verifyJoinPrometheus",
            wantedIps,
            readyIps,
            missingIps,
            ageSeconds: age,
          },
        });

        if (missingIps.length === 0) {
          // Success! All nodes joined.
          await completeScaleUp({
            tableName,
            actionId: s.scaleUpActionId,
            nowEpoch: now,
          });
          return {
            ok: true,
            decision: { type: "NOOP", reason: "scaleUpCompleted" },
          };
        }

        // Check for timeout
        if (age > joinTimeoutSec) {
          await failScaleUp({ tableName, actionId: s.scaleUpActionId });
          return {
            ok: true,
            decision: { type: "NOOP", reason: "scaleUpJoinTimeout" },
          };
        }

        return {
          ok: true,
          decision: { type: "NOOP", reason: "scaleUpJoinPending" },
        };
      } catch (e) {
        // Log error and wait for next run
        console.error("Verification failed", e);
        return { ok: true, decision: { type: "NOOP", reason: "verifyError" } };
      }
    }

    // If scaling started but instance ids were never recorded:
    // wait a bit, then clear
    if (age > 180) {
      await failScaleUp({ tableName, actionId: s.scaleUpActionId });

      await writeLog({
        tableName: logsTable,
        requestId: owner,
        nowEpoch: now,
        payload: {
          phase: "scaleUpMissingInstancesIdsCleared",
          scaleUpActionId: s.scaleUpActionId,
          ageSeconds: age,
        },
      });

      return {
        ok: true,
        decision: { type: "NOOP", reason: "scaleUpMissingInstancesIdsCleared" },
      };
    }

    await writeLog({
      tableName: logsTable,
      requestId: owner,
      nowEpoch: now,
      payload: {
        phase: "scaleUpMissingInstanceIdsWaiting",
        scaleUpActionId: s.scaleUpActionId,
        ageSeconds: age,
      },
    });

    return {
      ok: true,
      decision: { type: "NOOP", reason: "scaleUpMissingInstanceIdsWaiting" },
    };
  }

  if (s.scalingInProgress && s.scaleDownActionId) {
    return await resumeScaleDown({
      tableName,
      logsTable,
      lock,
      owner,
      now,
      masterIp,
      k8sApiToken,
      state: s,
    });
  }

  // Metrics

  const { avgCpu, pendingPods, pendingLongEnough, idleLongEnough } =
    await getMetrics(prometheusBaseURL);

  const runningWorkers = await listRunningWorkers(workerTagKey, workerTagValue);

  const workerCount = runningWorkers.length;

  // Reload state for decision
  s = await loadState(tableName);

  const decision = decide(
    cfg,
    {
      avgCpu,
      pendingPods,
      pendingLongEnough,
      idleLongEnough,
      nowEpoch: now,
    },
    {
      scalingInProgress: s.scalingInProgress,
      lastScaleEpoch: s.lastScaleEpoch,
      scaleUpActionId: s.scaleUpActionId,
      workerCount,
    }
  );

  // Always log the decision snapshot (even NOOP)
  await writeLog({
    tableName: logsTable,
    requestId: owner,
    nowEpoch: now,
    payload: {
      phase: "decision",
      prometheusBaseURL,
      avgCpu,
      pendingPods,
      pendingLongEnough,
      idleLongEnough,
      workerCount,
      lastScaleEpoch: s.lastScaleEpoch,
      scalingInProgress: s.scalingInProgress,
      decision,
    },
  });

  if (decision.type === "NOOP") {
    return { ok: true, decision };
  }

  if (decision.type === "SCALE_DOWN") {
    // SCALE_DOWN
    const sinceLast = now - (s.lastScaleEpoch ?? 0);
    const cooldownDownSec = Number(process.env.COOLDOWN_DOWN_SEC ?? "600");

    if (sinceLast < cooldownDownSec) {
      return {
        ok: true,
        decision: {
          type: "NOOP",
          reason: `Cooldown for down operation active`,
        },
      };
    }

    // 1. Safety Check: Is the Master SSM/K8s responsive?

    // Determine how many we can actually remove without dropping below minWorker
    const toRemoveCount = Math.min(
      decision.toRemove ?? 1,
      workerCount - cfg.minWorkers
    );

    if (toRemoveCount <= 0)
      return {
        ok: true,
        decision: { type: "NOOP", reason: "minWorkersReached" },
      };

    const actionId = `sd-${now}-${owner}`;
    const acquired = await lock.acquire(decision.lockKey, owner, now, 300);

    if (!acquired)
      return {
        ok: true,
        decision: {
          type: "NOOP",
          reason: "lockHeld",
        },
      };

    try {
      const targets = pickScaleDownTargetsMultiAz(
        runningWorkers,
        toRemoveCount
      );

      const targetIds = targets.map((t) => t.instanceId);

      // Persist intent BEFORE touching the cluster
      await beginScaleDown({
        tableName,
        nowEpoch: now,
        actionId,
        targetInstanceIds: targetIds,
      });

      s = await loadState(tableName);

      const completed = new Set(s.scaleDownCompletedInstanceIds ?? []);

      const drainTimeout = 5 * 60 * 1000;

      const terminated: string[] = [];

      for (const target of targets) {
        if (completed.has(target.instanceId)) continue;

        // Convert IP to k3s Node Name
        const nodeName = `ip-${target.privateIp.replace(/\./g, "-")}`;

        try {
          console.log(`Starting graceful drain for ${nodeName}`);
          const res = await gracefulDrain(
            masterIp,
            nodeName,
            k8sApiToken,
            drainTimeout
          );

          await writeLog({
            tableName: logsTable,
            requestId: owner,
            nowEpoch: now,
            payload: {
              phase: "scaleDownDrainResult",
              nodeName,
              instanceId: target.instanceId,
              result: res,
            },
          });

          if (!res.ok) {
            return {
              ok: true,
              decision: { type: "NOOP", reason: `drainFailed: ${res.reason}` },
            };
          }

          // Drain succeeded, terminate this instance
          await terminateInstances([target.instanceId]);
          terminated.push(target.instanceId);
          await markScaleDownInstanceDone({
            tableName,
            actionId,
            instanceId: target.instanceId,
          });
        } catch (err: any) {
          console.error("Scale down failed:", err);
          return { ok: false, error: err.message };
        }
      }

      await completeScaleDown({
        tableName,
        actionId,
        nowEpoch: now,
      });

      await writeLog({
        tableName: logsTable,
        requestId: owner,
        nowEpoch: now,
        payload: { phase: "scaleDownSuccess", terminated },
      });

      return { ok: true, decision, terminated };
    } catch (err) {
    } finally {
      await lock.release(decision.lockKey, owner, now, false);
    }

    return {
      ok: true,
      decision: { type: "NOOP", reason: "scaleDownNotImplementedYet" },
    };
  }

  // ---------------------------
  // PHASE 1: SCALE UP (LAUNCH MODE)
  // ---------------------------

  // respect cooldown UP (5 Min)
  const sinceLast = now - (s.lastScaleEpoch ?? 0);

  if (s.lastScaleEpoch && sinceLast < cooldownUpSec) {
    await writeLog({
      tableName: logsTable,
      requestId: owner,
      nowEpoch: now,
      payload: { phase: "cooldownUpActive", sinceLast, cooldownUpSec },
    });
    return {
      ok: true,
      decision: { type: "NOOP", reason: `cooldownUpActive(${sinceLast}s)` },
    };
  }

  // compute toLaunch ONLY for SCALE_UP
  const podsPerNode = Number(process.env.PODS_PER_NODE ?? "10");
  const maxBatch = Number(process.env.MAX_BATCH_UP ?? "2");
  const maxWorkers = Number(process.env.MAX_WORKERS ?? "10");

  let desiredDelta = Math.ceil(pendingPods / podsPerNode);
  desiredDelta = Math.max(1, desiredDelta);
  desiredDelta = Math.min(desiredDelta, maxBatch);

  // Respect max workers
  const room = Math.max(0, maxWorkers - workerCount);
  const toLaunch = Math.min(desiredDelta, room);

  if (toLaunch <= 0) {
    await writeLog({
      tableName: logsTable,
      requestId: owner,
      nowEpoch: now,
      payload: { phase: "maxWorkersReached", workerCount: maxWorkers },
    });
    return {
      ok: true,
      decision: { type: "NOOP", reason: "maxWorkersReached" },
    };
  }

  // Lock is Mandatory
  const acquired = await lock.acquire(decision.lockKey, owner, now, 300);

  if (!acquired) {
    await writeLog({
      tableName: logsTable,
      requestId: owner,
      nowEpoch: now,
      payload: { phase: "lockNotAcquired", lockKey: decision.lockKey },
    });
    return {
      ok: true,
      decision: { type: "NOOP", reason: "lockHeldByOtherInvocation" },
    };
  }

  const actionId = `${now}-${owner}`;
  let launchedIds: string[] = [];

  try {
    // Re-load state under lock
    s = await loadState(tableName);

    if (s.scalingInProgress) {
      // Someone else started scaling; let verify-mode handle it next run
      await writeLog({
        tableName: logsTable,
        requestId: owner,
        nowEpoch: now,
        payload: {
          phase: "scalingAlreadyInProgress",
          actionId: s.scaleUpActionId ?? null,
        },
      });
      return {
        ok: true,
        decision: { type: "NOOP", reason: "scalingAlreadyInProgress" },
      };
    }

    // Conditional begin in DynamoDB (prevents duplicate scale-ups even if lock expiry happens)
    await beginScaleUp({
      tableName,
      nowEpoch: now,
      actionId,
      requested: toLaunch,
    });

    const subnetIds = (process.env.WORKER_SUBNET_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const subnetAz = await describeSubnetsAz(subnetIds);

    if (subnetAz.length === 0) {
      throw new Error(
        "No subnets returned from describeSubnetAz; check WORKER_SUBNET_IDS env"
      );
    }

    // Build AZ -> [subnetIds]
    const subnetsByAz = new Map<string, string[]>();
    for (const s of subnetAz) {
      subnetsByAz.set(s.availabilityZone, [
        ...(subnetsByAz.get(s.availabilityZone) ?? []),
        s.subnetId,
      ]);
    }

    const currentWorkers = await listRunningWorkers(
      workerTagKey,
      workerTagValue
    );

    // Count current workers per AZ
    const azCounts = new Map<string, number>();
    for (const w of currentWorkers) {
      azCounts.set(
        w.availabilityZone,
        (azCounts.get(w.availabilityZone) ?? 0) + 1
      );
    }

    // Launch one-by-one into least-filled AZ
    launchedIds = [];
    const chosen: { az: string; subnetId: string }[] = [];
    for (let i = 0; i < toLaunch; i++) {
      const candidateAzs = [...subnetsByAz.keys()];
      candidateAzs.sort(
        (a, b) => (azCounts.get(a) ?? 0) - (azCounts.get(b) ?? 0)
      );

      const chosenAz = candidateAzs[0];
      const azSubnets = subnetsByAz.get(chosenAz)!;

      if (!azSubnets || azSubnets.length === 0) {
        throw new Error(`No subnets found for chosen AZ ${chosenAz}`);
      }

      const chosenSubnet = azSubnets[i % azSubnets.length];
      let ids: string[] = [];
      try {
        ids = await launchWorkers(masterIp, 1, clusterToken, {
          subnetId: chosenSubnet,
          marketType: "spot",
        });
      } catch (error) {
        ids = await launchWorkers(masterIp, 1, clusterToken, {
          subnetId: chosenSubnet,
          marketType: "on-demand",
        });
      }

      launchedIds.push(...ids);
      chosen.push({ az: chosenAz, subnetId: chosenSubnet });
      azCounts.set(chosenAz, (azCounts.get(chosenAz) ?? 0) + 1);
    }

    await recordScaleUpInstances({
      tableName,
      actionId,
      instanceIds: launchedIds,
    });

    await writeLog({
      tableName: logsTable,
      requestId: owner,
      nowEpoch: now,
      payload: {
        phase: "scaleUpLaunched",
        actionId,
        launchedInstanceIds: launchedIds,
        toLaunch,
        masterPrivateIp: masterIp,
        azPlan: chosen,
      },
    });

    return {
      ok: true,
      decision,
      scaleUp: {
        requested: toLaunch,
        launched: launchedIds.length,
        instanceIds: launchedIds,
      },
    };
  } catch (e: unknown) {
    // after you compute decision/plan:
    await writeLog({
      tableName: logsTable,
      requestId: owner,
      nowEpoch: now,
      payload: {
        phase: "scaleUpError",
        error: String(e),
        masterPrivateIp: masterIp || undefined,
        toLaunch,
        decision,
      },
    });
    throw e;
  } finally {
    // Always release. Only set lastScaleEpoch if we actually launched something.
    try {
      await lock.release(
        decision.lockKey,
        owner,
        Math.floor(Date.now() / 1000),
        false
      );
    } catch (releaseErr) {
      // don't crash the whole run because release failed; log it
      await writeLog({
        tableName: logsTable,
        requestId: owner,
        nowEpoch: Math.floor(Date.now() / 1000),
        payload: {
          phase: "lockReleaseError",
          error: String(releaseErr),
          launchedIds,
        },
      });
    }

    await writeLog({
      tableName: logsTable,
      requestId: owner,
      nowEpoch: Math.floor(Date.now() / 1000),
      payload: {
        phase: "scaleUpResult",
        masterPrivateIp: masterIp || undefined,
        launchedInstanceIds: launchedIds,
        toLaunch,
        decision,
      },
    });
  }
};

function mustEnv(k: string): string {
  const v = process.env[k];

  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

type DrainResult = {
  ok: boolean;
  reason: string;
  startedAt: number;
  finishedAt: number;
  evicted: { ns: string; name: string }[];
  remaining: { ns: string; name: string; kind?: string }[];
};

const CRITICAL_PRIORITY_CLASSES = new Set([
  "system-node-critical",
  "system-cluster-critical",
]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isDaemonSetPod(pod: any): boolean {
  return !!pod.metadata?.ownerReferences?.some(
    (r: any) => r.kind === "DaemonSet"
  );
}

function isMirrorStaticPod(pod: any): boolean {
  return !!pod.metadata?.annotations?.["kubernetes.io/config.mirror"];
}

function isCriticalSystemPod(pod: any): boolean {
  const ns = pod.metadata?.namespace;
  const pc = pod.spec?.priorityClassName;

  if (CRITICAL_PRIORITY_CLASSES.has(pc)) return true;

  // kube-system pods that are NOT daemonsets are treated as critical for scale-down safety
  if (ns === "kube-system" && !isDaemonSetPod(pod)) return true;

  // Mirror/static pods are managed outside the API; draining them is not what you want.
  if (isMirrorStaticPod(pod)) return true;

  return false;
}

function isEvictablePod(pod: any): boolean {
  // Do not evict DaemonSet pods
  if (isDaemonSetPod(pod)) return false;

  // Do not try to evict mirror/static pods
  if (isMirrorStaticPod(pod)) return false;

  // Also ignore succeeded/failed pods
  const phase = pod.status?.phase;
  if (phase === "Succeeded" || phase === "Failed") return false;

  return true;
}

async function listPodsOnNode(
  k8sApi: any,
  baseUrl: string,
  headers: any,
  nodeName: string
) {
  const podsRes = await k8sApi.get(
    `${baseUrl}/api/v1/pods?fieldSelector=spec.nodeName=${encodeURIComponent(
      nodeName
    )}`,
    { headers }
  );
  return podsRes.data.items ?? [];
}

async function cordonNode(
  k8sApi: any,
  baseUrl: string,
  headers: any,
  nodeName: string
) {
  await k8sApi.patch(
    `${baseUrl}/api/v1/nodes/${encodeURIComponent(nodeName)}`,
    { spec: { unschedulable: true } },
    {
      headers: {
        ...headers,
        "Content-Type": "application/strategic-merge-patch+json",
      },
    }
  );
}

async function evictPod(k8sApi: any, baseUrl: string, headers: any, pod: any) {
  const ns = pod.metadata.namespace;
  const name = pod.metadata.name;

  // policy/v1 eviction endpoint
  return k8sApi.post(
    `${baseUrl}/api/v1/namespaces/${encodeURIComponent(
      ns
    )}/pods/${encodeURIComponent(name)}/eviction`,
    {
      apiVersion: "policy/v1",
      kind: "Eviction",
      metadata: { name, namespace: ns },
    },
    { headers }
  );
}

/**
 * Requirement-compliant drain:
 * - cordon
 * - abort if critical system pods exist
 * - attempt eviction until only non-evictable pods remain
 * - hard stop at 5 minutes
 */
export async function gracefulDrain(
  masterIp: string,
  nodeName: string,
  token: string,
  drainTimeoutMs = 5 * 60 * 1000
): Promise<DrainResult> {
  const startedAt = Date.now();

  const k8sApi = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 15_000, // per-request, not overall drain
  });

  const baseUrl = `https://${masterIp}:6443`;
  const headers = { Authorization: `Bearer ${token}` };

  // 1) Cordon first
  await cordonNode(k8sApi, baseUrl, headers, nodeName);

  // 2) Pre-check critical pods
  const initialPods = await listPodsOnNode(k8sApi, baseUrl, headers, nodeName);
  const critical = initialPods.filter(isCriticalSystemPod);
  if (critical.length > 0) {
    return {
      ok: false,
      reason: `criticalSystemPodsPresent(${critical
        .map((p: any) => `${p.metadata.namespace}/${p.metadata.name}`)
        .join(",")})`,
      startedAt,
      finishedAt: Date.now(),
      evicted: [],
      remaining: critical.map((p: any) => ({
        ns: p.metadata.namespace,
        name: p.metadata.name,
        kind: p.metadata.ownerReferences?.[0]?.kind,
      })),
    };
  }

  const deadline = startedAt + drainTimeoutMs;
  const evicted: { ns: string; name: string }[] = [];

  // 3) Eviction loop until drained or timeout
  // Backoff helps with API pressure and gives controllers time to reschedule
  let backoffMs = 500;

  while (Date.now() < deadline) {
    const pods = await listPodsOnNode(k8sApi, baseUrl, headers, nodeName);

    // If critical pods appear mid-drain, abort (rare but possible)
    const newlyCritical = pods.filter(isCriticalSystemPod);
    if (newlyCritical.length > 0) {
      return {
        ok: false,
        reason: `criticalSystemPodsAppeared(${newlyCritical
          .map((p: any) => `${p.metadata.namespace}/${p.metadata.name}`)
          .join(",")})`,
        startedAt,
        finishedAt: Date.now(),
        evicted,
        remaining: newlyCritical.map((p: any) => ({
          ns: p.metadata.namespace,
          name: p.metadata.name,
        })),
      };
    }

    const evictable = pods.filter(isEvictablePod);

    // Drain done: only DaemonSets/mirror/completed pods remain
    if (evictable.length === 0) {
      return {
        ok: true,
        reason: "drained",
        startedAt,
        finishedAt: Date.now(),
        evicted,
        remaining: [],
      };
    }

    // Try evict evictable pods
    for (const pod of evictable) {
      // Stop early if time is up
      if (Date.now() >= deadline) break;

      const ns = pod.metadata.namespace;
      const name = pod.metadata.name;

      try {
        await evictPod(k8sApi, baseUrl, headers, pod);
        evicted.push({ ns, name });
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = err?.response?.data
          ? JSON.stringify(err.response.data)
          : String(err);

        // 429 is typical when a PDB blocks eviction (or too many requests)
        if (status === 429) {
          return {
            ok: false,
            reason: `pdbOrEvictionBlocked(429) on ${ns}/${name}: ${msg}`,
            startedAt,
            finishedAt: Date.now(),
            evicted,
            remaining: [{ ns, name }],
          };
        }

        // 404 means it disappeared between list and eviction; ignore
        if (status === 404) continue;

        // Anything else is real failure
        return {
          ok: false,
          reason: `evictionFailed(${
            status ?? "unknown"
          }) on ${ns}/${name}: ${msg}`,
          startedAt,
          finishedAt: Date.now(),
          evicted,
          remaining: [{ ns, name }],
        };
      }
    }

    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 5000);
  }

  // 4) Timeout: must not terminate
  const podsLeft = await listPodsOnNode(k8sApi, baseUrl, headers, nodeName);
  const remaining = podsLeft
    .filter(isEvictablePod)
    .map((p: any) => ({ ns: p.metadata.namespace, name: p.metadata.name }));

  return {
    ok: false,
    reason: `drainTimeout(${Math.floor(drainTimeoutMs / 1000)}s)`,
    startedAt,
    finishedAt: Date.now(),
    evicted,
    remaining,
  };
}

function pickScaleDownTargetsMultiAz(
  workers: {
    availabilityZone: string;
    launchTime: Date;
  }[],
  toRemoveCount: number
) {
  const byAz = new Map<string, any[]>();

  for (const w of workers) {
    byAz.set(w.availabilityZone, [...(byAz.get(w.availabilityZone) ?? []), w]);
  }

  // Sort each AZ bucket by oldest first
  for (const [az, list] of byAz.entries()) {
    list.sort(
      (a, b) =>
        new Date(a.launchTime).getTime() - new Date(b.launchTime).getTime()
    );
    byAz.set(az, list);
  }

  const targets: any[] = [];
  const azCount = byAz.size;

  while (targets.length < toRemoveCount) {
    const azs = [...byAz.keys()];
    azs.sort((a, b) => byAz.get(b)!.length - byAz.get(a)!.length);

    const chosenAz = azs[0];

    const list = byAz.get(chosenAz)!;

    if (list?.length === 0) break;

    // if we have multiple AZs, avoid taking an AZ to zero if possible
    if (azCount >= 2 && list.length <= 1) {
      // try next AZ
      const nextAz = azs.find((az) => (byAz.get(az)?.length ?? 0) > 1);
      if (!nextAz) break;
      targets.push(byAz.get(nextAz)!.shift());
      continue;
    }

    targets.push(list?.shift());
  }

  return targets;
}

async function handleSpotEvent(
  event: any,
  ctx: {
    tableName: string;
    logsTable: string;
    lock: DynamoDbLockProvider;
    owner: string;
    now: number;
    k8sApiToken: string;
    clusterToken: string;
    workerTagKey: string;
    workerTagValue: string;
    promNodePort: string;
  }
) {
  const instanceId = event?.detail?.["instance-id"];
  const detailType = event?.["detail-type"] ?? "unknown";

  if (!instanceId) {
    return {
      ok: true,
      decision: { type: "NOOP", reason: "spotEventMissingInstanceId" },
    };
  }

  const lockKey = `spot:${instanceId}`;

  const acquired = await ctx.lock.acquire(lockKey, ctx.owner, ctx.now, 180);

  if (!acquired) {
    return { ok: true, decision: { type: "NOOP", reason: "spotLockHeld" } };
  }

  try {
    const masterIp = await findMasterPrivateIp();

    // Find private IP -> nodeName
    const pairs = await getPrivateIpsForInstanceIds([instanceId]);

    const ip = pairs[0]?.ip;

    if (!ip) {
      await writeLog({
        tableName: ctx.logsTable,
        requestId: ctx.owner,
        nowEpoch: ctx.now,
        payload: { phase: "spotEventNoPrivateIp", instanceId, detailType },
      });

      // Still try to replace capacity
      await launchReplacementWorker(masterIp, ctx);
      return {
        ok: true,
        decision: { type: "NOOP", reason: "spotEventNoPrivateIpReplaced" },
      };
    }

    const nodeName = `ip-${ip.replace(/\./g, "-")}`;

    // Tight timeout: spot gives ~2 minutes
    const drainTimeoutMs = 110_000;

    const drainRes = await gracefulDrain(
      masterIp,
      nodeName,
      ctx.k8sApiToken,
      drainTimeoutMs
    );

    await writeLog({
      tableName: ctx.logsTable,
      requestId: ctx.owner,
      nowEpoch: ctx.now,
      payload: {
        phase: "spotInterruptionHandled",
        detailType,
        instanceId,
        nodeName,
        drainRes,
      },
    });

    // Terminate proactively
    try {
      await terminateInstances([instanceId]);
    } catch {}

    // Replace capacity immediately (AZ-aware, spot-first, fallback)
    await launchReplacementWorker(masterIp, ctx);

    return { ok: true, decision: { type: "NOOP", reason: "spotHandled" } };
  } catch (error) {
    await writeLog({
      tableName: ctx.logsTable,
      requestId: ctx.owner,
      nowEpoch: ctx.now,
      payload: {
        phase: "spotInterruptionError",
        error: String(error),
        instanceId,
        detailType,
      },
    });

    return { ok: false, error: String(error) };
  } finally {
    await ctx.lock.release(lockKey, ctx.owner, ctx.now, false);
  }
}

async function launchReplacementWorker(
  masterIp: string,
  ctx: {
    clusterToken: string;
    workerTagKey: string;
    workerTagValue: string;
    logsTable: string;
    owner: string;
    now: number;
  }
) {
  const runningWorkers = await listRunningWorkers(
    ctx.workerTagKey,
    ctx.workerTagValue
  );

  const subnetIds = (process.env.WORKER_SUBNET_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const subnetAz = await describeSubnetsAz(subnetIds);

  const subnetByAz = new Map<string, string[]>();

  for (const s of subnetAz) {
    subnetByAz.set(s.availabilityZone, [
      ...(subnetByAz.get(s.availabilityZone) ?? []),
      s.subnetId,
    ]);
  }

  if (subnetByAz.size === 0) {
    throw new Error("No subnet Azs available for replacement launch");
  }

  // Count current workers per AZ
  const azCounts = new Map<string, number>();
  for (const w of runningWorkers) {
    azCounts.set(
      w.availabilityZone,
      (azCounts.get(w.availabilityZone) ?? 0) + 1
    );
  }

  // Choose least-filled AZ
  const candidateAzs = [...subnetByAz.keys()];
  candidateAzs.sort((a, b) => (azCounts.get(a) ?? 0) - (azCounts.get(b) ?? 0));
  const chosenAz = candidateAzs[0];

  const azSubnets = subnetByAz.get(chosenAz)!;
  if (azSubnets.length === 0)
    throw new Error(`No subnets in chosen AZ ${chosenAz}`);

  const chosenSubnet = azSubnets[0];

  // Sport first with fallback

  try {
    const ids = await launchWorkers(masterIp, 1, ctx.clusterToken, {
      subnetId: chosenSubnet,
      marketType: "spot",
    });

    await writeLog({
      tableName: ctx.logsTable,
      requestId: ctx.owner,
      nowEpoch: ctx.now,
      payload: {
        phase: "spotReplacementLaunched",
        market: "spot",
        chosenAz,
        chosenSubnet,
        ids,
      },
    });

    return ids;
  } catch (error: any) {
    const ids = await launchWorkers(masterIp, 1, ctx.clusterToken, {
      subnetId: chosenSubnet,
      marketType: "on-demand",
    });

    await writeLog({
      tableName: ctx.logsTable,
      requestId: ctx.owner,
      nowEpoch: ctx.now,
      payload: {
        phase: "spotReplacementLaunched",
        market: "on-demand",
        chosenAz,
        chosenSubnet,
        ids,
        reason: String(error),
      },
    });
  }
}

async function resumeScaleDown(params: {
  tableName: string;
  logsTable: string;
  lock: DynamoDbLockProvider;
  owner: string;
  now: number;
  masterIp: string;
  k8sApiToken: string;
  state: any;
}) {
  const {
    tableName,
    logsTable,
    lock,
    owner,
    now,
    masterIp,
    k8sApiToken,
    state,
  } = params;

  if (
    state.scaleDownStartedEpoch &&
    now - state.scaleDownStartedEpoch > 900 // 15 minutes
  ) {
    await failScaleDown({
      tableName,
      actionId: state.scaleDownActionId!,
    });
    return {
      ok: true,
      decision: { type: "NOOP", reason: "scaleDownTimedOut" },
    };
  }

  const acquired = await lock.acquire("cluster", owner, now, 300);
  if (!acquired)
    return { ok: true, decision: { type: "NOOP", reason: "scaleDownLocked" } };

  try {
    const completed = new Set(state.scaleDownCompletedInstanceIds ?? []);
    const targets = state.scaleDownTargetInstanceIds ?? [];

    for (const instanceId of targets) {
      if (completed.has(instanceId)) continue;

      const pairs = await getPrivateIpsForInstanceIds([instanceId]);
      const ip = pairs[0]?.ip;
      if (!ip) continue;

      const nodeName = `ip-${ip.replace(/\./g, "-")}`;
      const res = await gracefulDrain(
        masterIp,
        nodeName,
        k8sApiToken,
        5 * 60 * 1000
      );

      if (!res.ok)
        return { ok: true, decision: { type: "NOOP", reason: res.reason } };

      await terminateInstances([instanceId]);
      await markScaleDownInstanceDone({
        tableName,
        actionId: state.scaleDownActionId!,
        instanceId,
      });
    }

    await completeScaleDown({
      tableName,
      actionId: state.scaleDownActionId!,
      nowEpoch: now,
    });

    return { ok: true, decision: { type: "NOOP", reason: "scaleDownResumed" } };
  } finally {
    await lock.release("cluster", owner, now, false);
  }
}
