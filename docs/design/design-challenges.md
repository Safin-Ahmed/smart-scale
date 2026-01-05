# Design Challenges & Solutions

This document explains the key design challenges encountered while building the
K3s Autoscaler and how each challenge is addressed in the current architecture.

The focus is on correctness, safety, and recoverability under real-world
failure scenarios.

---

## 1. Race Condition Prevention

### Problem

Multiple Lambda invocations can run concurrently (EventBridge, retries, manual
invocations). Without protection, this can cause:

- Duplicate node launches
- Conflicting scale-up / scale-down operations
- Corrupted cluster state

---

### Solution

The autoscaler uses **DynamoDB conditional writes** to implement a
**distributed lock**.

#### Key Mechanisms

- `scalingInProgress` flag
- `lockOwner` (Lambda request ID)
- `lockUntilEpoch` (TTL-based expiry)

Lock acquisition uses a conditional expression:

```
attribute_not_exists(scalingInProgress)
OR scalingInProgress = false
OR lockUntilEpoch < now
```

This ensures:

- Only one scaling operation can run at a time
- Locks automatically expire if Lambda crashes or times out

---

### Lambda Timeout Handling

If a Lambda invocation:

- Times out
- Crashes
- Loses network connectivity

The lock **expires automatically** via `lockUntilEpoch`.

The next invocation safely recovers and continues.

---

### Result

- No double-scaling
- Crash-safe recovery
- Idempotent behavior across retries

---

## 2. Node Join Automation

### Problem

New EC2 instances must:

- Securely retrieve the K3s join token
- Join the correct cluster
- Be verified as Ready before scaling completes

Manual verification is not acceptable.

---

### Solution

#### Secure Join Configuration

- Join token passed via instance user data
- Master node discovered dynamically via EC2 tags
- No hardcoded IPs or credentials

#### Two-Phase Scale-Up Model

Scale-up is split into two phases:

**Phase 1: Launch**

- EC2 instances launched
- Instance IDs recorded in DynamoDB
- scalingInProgress = true

**Phase 2: Verify Join**

- Lambda re-invokes
- Uses Prometheus to get all the nodes information
- Confirms new nodes are `Ready`

If verification succeeds → scale-up completed  
If verification times out → state reset safely

---

### Why This Matters

- Lambda execution is time-bounded
- Node joins are asynchronous
- Verification must survive retries

This design ensures correctness even across multiple invocations.

---

## 3. Graceful Scale-Down

### Problem

Terminating a node with running pods can:

- Kill active user requests
- Cause service disruption
- Break StatefulSets

---

### Solution (Current Design)

Scale-down is intentionally conservative.

#### Safety Rules

- Only 1 node removed at a time
- Minimum worker count enforced
- Only scale down when cluster is idle
- No scale-down if pending pods exist

#### Planned Drain Flow

1. Acquire scaling lock
2. Select safest node (fewest pods, no system workloads)
3. `kubectl cordon`
4. `kubectl drain --timeout=5m`
5. Verify pod eviction
6. Terminate EC2 instance
7. Update state and release lock

---

### Stateful Workloads

- PodDisruptionBudgets are respected
- StatefulSets are excluded by default
- Drain timeout prevents infinite blocking

---

### Current Status

⚠️ Scale-down logic implemented but pending full validation under load.

---

## 4. Prometheus Connectivity

### Problem

Lambda must query Prometheus running inside the K3s cluster.

Challenges:

- Lambda runs outside the cluster
- Prometheus must be reachable securely
- Metrics must be reliable

---

### Solution

#### Exposure Method

- Prometheus exposed via **NodePort**
- Accessible only within VPC
- Security Groups restrict access to Lambda only

#### Why NodePort?

- Simple
- No external load balancer cost
- Predictable networking

#### Failure Handling

- If Prometheus is unreachable:
  - Autoscaler returns NOOP
  - No scaling decision is made
  - System fails safely

---

## 5. Cost Optimization vs Response Time

### Problem

Invoking Lambda every 2 minutes increases cost over time.

---

### Current Trade-Off

- Fast reaction to traffic spikes (≤ 3 minutes)
- Slightly higher Lambda invocation cost

This is acceptable for production reliability.

---

### Future Optimizations (Planned)

- Dynamic EventBridge schedules (peak vs off-peak)
- Metric-triggered invocations instead of polling
- Predictive scaling based on historical data

---

## Summary

This system prioritizes:

- Correctness over speed
- Safety over aggressiveness
- Recoverability over complexity

Every major failure mode has an explicit design response, making the autoscaler
robust under real-world conditions.
