import { decide, AutoScalerConfig } from "../core/decision";
import { getMetrics, getReadyNodeIps } from "../adapters/prometheus";
import axios from "axios";
import * as https from "https";
import {
  pickWorkerPrivateIp,
  listRunningWorkers,
  findMasterPrivateIp,
  launchWorkers,
  getPrivateIpsForInstanceIds,
  findMasterInstanceId,
  terminateInstances,
} from "../adapters/ec2";
import {
  beginScaleUp,
  completeScaleUp,
  ensureState,
  failScaleUp,
  loadState,
  recordScaleDown,
  recordScaleUpInstances,
} from "../adapters/state";
import { DynamoDbLockProvider } from "../adapters/dynamodbLock";
import { writeLog } from "../adapters/logSink";
import { runShellOnInstance } from "../adapters/ssm";

export const handler = async (event: any, context: any) => {
  const tableName = mustEnv("STATE_TABLE");
  const lock = new DynamoDbLockProvider(tableName);
  const logsTable = mustEnv("LOGS_TABLE");

  const now = Math.floor(Date.now() / 1000);
  const owner = context?.awsRequestId ?? `local=${now}`;
  const promNodePort = process.env.PROM_NODEPORT ?? "30900";

  const workerTagKey = process.env.WORKER_TAG_KEY ?? "Role";
  const workerTagValue = process.env.WORKER_TAG_VALUE ?? "k3s-worker";

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
  const workerIp = await pickWorkerPrivateIp(workerTagKey, workerTagValue);

  const prometheusBaseURL = `http://${workerIp}:${promNodePort}`;

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
    const masterIp = await findMasterPrivateIp();

    const k8sToken = process.env.K8S_API_TOKEN;

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
      // Sort workers by LaunchTime (Oldest First)
      const sortedWorkers = runningWorkers.sort((a, b) => {
        return (
          new Date(a.launchTime).getTime() - new Date(b.launchTime).getTime()
        );
      });

      const targets = sortedWorkers.slice(0, toRemoveCount);

      for (const target of targets) {
        // Convert IP to k3s Node Name
        const nodeName = `ip-${target.privateIp.replace(/\./g, "-")}`;

        try {
          console.log(`Starting graceful drain for ${nodeName}`);
          await gracefulDrain(masterIp, nodeName, k8sToken!);

          // ... call EC2 terminate command ...
        } catch (err: any) {
          console.error("Scale down failed:", err);
          return { ok: false, error: err.message };
        }
      }

      // Terminate EC2s and update state
      const targetIds = targets.map((t) => t.instanceId);
      await terminateInstances(targetIds);
      await recordScaleDown(tableName, now);

      await writeLog({
        tableName: logsTable,
        requestId: owner,
        nowEpoch: now,
        payload: { phase: "scaleDownSuccess", terminated: targetIds },
      });

      return { ok: true, decision, terminated: targetIds };
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
  let masterIp = "";

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

    masterIp = await findMasterPrivateIp();

    // Launch EC2 instances
    launchedIds = await launchWorkers(masterIp, toLaunch);

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

async function gracefulDrain(
  masterIp: string,
  nodeName: string,
  token: string
) {
  const k8sApi = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Ignore self-signed certs
  });
  const baseUrl = `https://${masterIp}:6443`;
  const headers = { Authorization: `Bearer ${token}` };

  // 1. Cordon
  await k8sApi.patch(
    `${baseUrl}/api/v1/nodes/${nodeName}`,
    { spec: { unschedulable: true } },
    {
      headers: {
        ...headers,
        "Content-Type": "application/strategic-merge-patch+json",
      },
    }
  );

  // 2. Evict
  const podsRes = await k8sApi.get(
    `${baseUrl}/api/v1/pods?fieldSelector=spec.nodeName=${nodeName}`,
    { headers }
  );
  for (const pod of podsRes.data.items) {
    if (
      pod.metadata.ownerReferences?.some((ref: any) => ref.kind === "DaemonSet")
    )
      continue;

    await k8sApi.post(
      `${baseUrl}/api/v1/namespaces/${pod.metadata.namespace}/pods/${pod.metadata.name}/eviction`,
      {
        apiVersion: "policy/v1",
        kind: "Eviction",
        metadata: { name: pod.metadata.name },
      },
      { headers }
    );
  }

  // 3. Grace period
  await new Promise((r) => setTimeout(r, 30000));
}

// async function verifyWorkersReadyViaSsm(instanceIds: string[]) {
//   // 1. Find Private IPs for those instances
//   const pairs = await getPrivateIpsForInstanceIds(instanceIds);
//   const wantedIps = pairs.map((p) => p.ip);

//   // 2. Run kubectl on master via SSM
//   const masterInstanceId = await findMasterInstanceId();

//   const cmd =
//     `k3s kubectl get nodes -o jsonpath='{range .items[*]}` +
//     `{.status.addresses[?(@.type=="InternalIP")].address}{" "}` +
//     `{.status.conditions[?(@.type=="Ready")].status}{"\\n"}` +
//     `{end}'`;

//   const res = await runShellOnInstance({
//     instanceId: masterInstanceId,
//     commands: [cmd],
//     timeoutSeconds: 55,
//   });

//   if (res.status !== "Success") {
//     throw new Error(
//       `SSM kubectl failed: status=${res.status} stderr=${res.stderr}`
//     );
//   }

//   // parse: "10.0.1.45 True"
//   const readyIps = new Set<string>();
//   for (const line of res.stdout.split("\n")) {
//     const t = line.trim();

//     if (!t) continue;

//     const [ip, ready] = t.split(/\s+/);
//     if (ip && ready === "True") readyIps.add(ip);
//   }

//   const missingIps = wantedIps.filter((ip) => !readyIps.has(ip));

//   return {
//     masterInstanceId,
//     instanceIds,
//     wantedIps,
//     readyIps: Array.from(readyIps),
//     missingIps,
//     raw: res.stdout.trim(),
//   };
// }
