# Scale-Up Algorithm

## Overview

The scale-up algorithm is designed to be **controlled, verifiable, and failure-tolerant**.

Unlike naive autoscalers that immediately assume success after instance launch, this system treats scale-up as a **two-phase operation**:

1. **Launch Phase** – provision infrastructure
2. **Verification Phase** – confirm nodes actually join and become Ready

This guarantees that scale-up decisions are based on **effective capacity**, not optimistic assumptions.

---

## Scale-Up Triggers

Scale-up is considered when **all** of the following conditions are met:

1. **CPU Pressure**

   - `avgCpu >= CPU_UP`

2. **Pending Work Exists**

   - One or more pods are pending
   - Pending duration ≥ `PENDING_UP_SEC`

3. **Cooldown Satisfied**

   - `now - lastScaleEpoch >= COOLDOWN_UP_SEC`

4. **Capacity Available**

   - `workerCount < maxWorkers`

5. **No Active Scaling**
   - `scalingInProgress == false`

If any condition fails, scale-up is skipped safely.

---

## Scale-Up Sizing Logic

The number of nodes to launch is computed as:

```
desiredDelta = ceil(pendingPods / PODS_PER_NODE)
```

Constraints applied:

- Minimum: `1`
- Maximum per invocation: `MAX_BATCH_UP`
- Never exceed `maxWorkers`

This prevents sudden bursts and allows gradual convergence.

---

## Scale-Up State Machine

Scale-up is modeled as a **durable, stateful workflow**.

### Phase 1: Begin Scale-Up (Planning)

Before launching instances:

- A unique `scaleUpActionId` is generated
- DynamoDB state is updated atomically:
  - `scalingInProgress = true`
  - `scaleUpActionId`
  - `scaleUpStartedEpoch`
  - `scaleUpRequested`
  - `scaleUpInstanceIds = []`

This uses a **conditional write** to ensure only one scale-up can begin.

---

### Phase 2: AZ-Aware Launch

Instances are launched **one-by-one**, not in bulk.

For each instance:

1. Count current workers per AZ
2. Select the **least-filled AZ**
3. Select a subnet within that AZ
4. Attempt **Spot** launch first
5. Fallback to **On-Demand** if Spot fails

This ensures:

- Balanced AZ distribution
- Reduced blast radius
- Cost optimization without sacrificing reliability

Each successful launch appends instance IDs locally.

---

### Phase 3: Persist Launch Results

After all launches:

- `scaleUpInstanceIds` is written to DynamoDB
- This enables later verification and recovery

No cooldown is applied yet.

---

### Phase 4: Verification (Join Confirmation)

In subsequent Lambda invocations, if:

```
scalingInProgress == true && scaleUpActionId exists
```

The autoscaler enters **verification mode**:

1. Resolve private IPs for launched instance IDs
2. Query Prometheus for Ready nodes
3. Compare expected IPs vs observed Ready IPs

#### Outcomes

- **All nodes Ready**

  - Scale-up is considered successful
  - Proceed to completion

- **Some nodes missing**
  - If `age < JOIN_TIMEOUT_SEC` → wait
  - If timeout exceeded → fail scale-up

---

### Phase 5: Completion

On successful verification:

- `scalingInProgress = false`
- `lastScaleEpoch = now`
- All scale-up fields are removed

Cooldown starts **only after capacity is confirmed live**.

---

### Phase 6: Failure Recovery

If nodes fail to join within `JOIN_TIMEOUT_SEC`:

- Scale-up is failed explicitly
- State is cleared
- Autoscaler is allowed to retry later

This prevents permanent deadlock.

---

## Crash & Retry Safety

Scale-up is resilient to:

- Lambda timeouts
- Partial EC2 launch success
- Verification failures
- Duplicate invocations

Because:

- All transitions are guarded by DynamoDB conditional writes
- Instance IDs are persisted
- Verification is idempotent

---

## Interaction With Other Systems

### With Scale-Down

- `scalingInProgress` prevents scale-up and scale-down from overlapping
- Cooldown is enforced after successful completion only

### With Spot Interruption Handling

- Spot interruptions are handled independently
- Replacement launches reuse the same AZ-aware logic
- No race conditions due to per-action locks

---

## Why This Design Is Correct

This scale-up approach avoids common autoscaling pitfalls:

- ❌ Assuming instance launch == usable capacity
- ❌ Bulk launching without AZ awareness
- ❌ Cooldown applied too early
- ❌ Stateless scaling decisions

Instead, it provides:

- Deterministic capacity changes
- Verified readiness
- Failure-safe retries
- Clear auditability

---

## Summary

The scale-up algorithm is:

- **Measured** – capacity grows incrementally
- **Verified** – nodes must join successfully
- **AZ-aware** – avoids single-AZ concentration
- **Resilient** – survives retries and failures
- **Cost-aware** – prefers Spot with fallback
