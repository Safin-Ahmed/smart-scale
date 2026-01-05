# Scaling Algorithm

This document describes the decision-making logic used by the K3s Autoscaler to
scale worker nodes up and down based on real-time cluster conditions.

The autoscaler runs as a periodic AWS Lambda function and evaluates metrics
collected from Prometheus.

---

## Metrics Used

The autoscaler relies on the following metrics:

### CPU Utilization

```promql
avg(rate(node_cpu_seconds_total{mode!="idle"}[5m]))
```

Represents average cluster-wide CPU usage

Smoothed over 5 minutes to avoid noise

Pending Pods

```promql
sum(kube_pod_status_phase{phase="Pending"})
```

Counts pods that cannot be scheduled due to insufficient capacity

Indicates immediate scaling pressure

Sustained Pending Pods

```promql
min_over_time((sum(kube_pod_status_phase{phase="Pending"}) > 0)[180s:])
```

Ensures pods have been pending for a meaningful duration

Prevents scaling on short scheduling spikes

Scale-Up Conditions: <br />
A scale-up decision is triggered if any of the following conditions are met:

- Average CPU usage > 70% for ≥ 3 minutes

- Pending pods exist continuously for ≥ 180 seconds

Additional constraints:

- Current worker count < MAX_WORKERS

- No scaling operation currently in progress

- Cooldown period has elapsed

Scale-Down Conditions: <br />
A scale-down decision is triggered if all of the following are met:

- Average CPU usage ≤ 30%

- No pending pods

- Cluster idle for ≥ 600 seconds

- Worker count > MIN_WORKERS

- No scaling operation currently in progress

- Cooldown period has elapsed

Cooldown Strategy: <br />
Cooldowns prevent oscillation and overreaction.

Action Cooldown <br />
Scale Up 5 minutes <br />
Scale Down 10 minutes

Cooldowns are enforced using timestamps stored in DynamoDB.

Scale-Up Batch Size
The autoscaler dynamically determines how many nodes to add:

```
desiredDelta = ceil(pendingPods / podsPerNode)
```

Where:

- podsPerNode is a heuristic (default: 10)

- Batch size is capped using MAX_BATCH_UP

- Hard capped by MAX_WORKERS

This allows fast response during spikes while avoiding over-provisioning.

Edge Case Handling: <br />

- If metrics are unavailable → NOOP

- If max workers reached → NOOP

- If scaling is already in progress → NOOP

- If cooldown active → NOOP

All decisions are logged for auditability.

**Summary** <br />
The scaling algorithm prioritizes:

- Safety over aggressiveness

- Sustained signals over spikes

- Deterministic behavior under concurrency

This design ensures predictable, debuggable scaling behavior in production.
s
