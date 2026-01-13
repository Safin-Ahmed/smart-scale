# Scale-Down Algorithm

## Overview

The scale-down algorithm is designed to be **safe, deterministic, resumable, and failure-tolerant**.

Unlike scale-up (which is mostly additive), scale-down is **destructive** and therefore must:

- Never remove capacity too aggressively
- Never violate Kubernetes safety constraints
- Never deadlock if a Lambda invocation fails mid-operation
- Never collapse availability across AZs
- Respect strict cooldown and minimum worker guarantees

This implementation explicitly treats scale-down as a **stateful, multi-phase workflow**, not a single action.

---

## Scale-Down Preconditions

Scale-down is considered **only if all of the following are true**:

1. **Decision Engine Requests Scale-Down**

   - Average CPU < `CPU_DOWN`
   - No pending pods
   - Cluster has been idle for `IDLE_DOWN_SEC`

2. **Cooldown Satisfied**

   - `now - lastScaleEpoch >= COOLDOWN_DOWN_SEC`

3. **Minimum Capacity Preserved**

   - `workerCount - toRemove >= minWorkers`

4. **No Other Scaling in Progress**
   - `scalingInProgress == false`

If any condition fails, scale-down is skipped safely.

---

## Scale-Down Safety Guarantees

### 1. Kubernetes Safety

Each node is drained using a **strict, requirement-compliant drain**:

- Node is cordoned before eviction
- DaemonSet pods are ignored
- Static/mirror pods are never touched
- Pods with `system-node-critical` or `system-cluster-critical` priority abort the drain
- kube-system pods (non-DaemonSet) are treated as critical
- Hard timeout of **5 minutes**
- If drain fails → instance is **NOT terminated**

### 2. AZ-Aware Capacity Protection

Scale-down targets are selected to:

- Prefer AZs with **higher worker counts**
- Avoid draining an AZ to zero when multiple AZs exist
- Remove **oldest nodes first** (FIFO)

This preserves availability during partial outages.

### 3. Idempotency & Crash Safety

Scale-down progress is persisted in DynamoDB, allowing:

- Safe retries
- Partial completion recovery
- No duplicate drains or terminations

---

## Scale-Down State Machine

Scale-down is modeled as a **tracked action** with explicit state transitions.

### Phase 1: Planning (Begin Scale-Down)

Before any node is touched:

- Select scale-down targets using AZ-aware logic
- Persist the plan in DynamoDB:
  - `scaleDownActionId`
  - `scaleDownStartedEpoch`
  - `scaleDownTargetInstanceIds`
  - `scaleDownCompletedInstanceIds = []`
  - `scalingInProgress = true`

This ensures the plan survives Lambda crashes.

---

### Phase 2: Execution (Drain + Terminate)

For each target instance:

1. Skip instance if already in `scaleDownCompletedInstanceIds`
2. Convert private IP → Kubernetes node name
3. Perform graceful drain
4. If drain succeeds:
   - Terminate EC2 instance
   - Record instance ID as completed in DynamoDB
5. If drain fails:
   - Abort scale-down
   - Leave state intact for retry

Each instance is processed independently and safely.

---

### Phase 3: Resume (Failure Recovery)

If Lambda crashes mid-scale-down:

- Next invocation detects:
  - `scalingInProgress == true`
  - `scaleDownActionId` present
- Remaining instances are computed as:
  - scaleDownTargetInstanceIds - scaleDownCompletedInstanceIds
- Processing resumes from where it stopped

This prevents:

- Double drains
- Duplicate terminations
- Lost progress

---

### Phase 4: Completion

Once all target instances are terminated:

- Clear all scale-down fields
- Set `scalingInProgress = false`
- Update `lastScaleEpoch = now`

Cooldown begins **only after successful completion**.

---

### Phase 5: Deadlock Recovery (Fail-Safe)

If scale-down exceeds a safety threshold (e.g. 15 minutes):

- Action can be force-cleared
- `scalingInProgress = false`
- Scale-down fields removed

This guarantees the autoscaler never gets stuck permanently.

---

## Interaction With Spot Interruptions

Scale-down logic is **independent** of spot interruption handling:

- Spot events trigger immediate, targeted drain + replacement
- Scheduled scale-down never races with spot handling due to:
- Per-action DynamoDB locks
- `scalingInProgress` gating

This separation prevents cascading failures.

---

## Why This Design Works

This approach intentionally avoids shortcuts:

- ❌ No blind EC2 termination
- ❌ No stateless drain attempts
- ❌ No AZ-unaware node removal

Instead, it provides:

- Deterministic behavior
- Clear auditability
- Failure resilience
- Production-grade safety

This is the same philosophy used by real-world cluster autoscalers, adapted explicitly for K3s + Lambda constraints.

---

## Summary

The scale-down algorithm is:

- **Safe**: respects Kubernetes and AZ constraints
- **Resilient**: survives Lambda crashes and retries
- **Predictable**: state-driven and auditable
- **Minimal**: no unnecessary complexity or external workflow engines

It intentionally treats node removal as a **transaction**, not a fire-and-forget operation.
