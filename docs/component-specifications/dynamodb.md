# DynamoDB – Component Specification

## Purpose

DynamoDB provides durable coordination and state tracking for the autoscaler. It is used to:

- Prevent race conditions between concurrent Lambda invocations
- Persist scaling state across failures/timeouts
- Track active scaling operations (scale-up and scale-down)
- Enforce cooldown behavior using timestamps
- Support idempotent and resumable workflows

The autoscaler uses a **single logical cluster record** (`pk="cluster"`) rather than one item per node.

> Note: A separate logs table (`LOGS_TABLE`) stores structured scaling logs/events (decision snapshots, drain results, spot events, etc.). This doc focuses on the **state table**.

---

## Table: Autoscaler State (`STATE_TABLE`)

### Primary Key

- Partition key: `pk` (String)
- Cluster item key: `pk = "cluster"`

There is exactly one state item per cluster.

---

## State Attributes

### Core Fields (Shared)

| Attribute           | Type | Description                                                                   |
| ------------------- | ---- | ----------------------------------------------------------------------------- |
| `pk`                | S    | Constant `"cluster"`                                                          |
| `scalingInProgress` | BOOL | Global flag indicating a scaling operation is active (scale-up or scale-down) |
| `lastScaleEpoch`    | N    | Epoch timestamp of the last completed scale action; used for cooldown         |
| `pendingSinceEpoch` | N    | Timestamp marking when pending condition started                              |
| `idleSinceEpoch`    | N    | Timestamp marking when idle condition started                                 |
| `workerCount`       | N    | Snapshot of current worker count                                              |

---

## Scale-Up Tracking Fields

Scale-up uses a begin → record → verify → complete/fail flow.

| Attribute             | Type | Description                                    |
| --------------------- | ---- | ---------------------------------------------- |
| `scaleUpActionId`     | S    | Unique scale-up action identifier              |
| `scaleUpStartedEpoch` | N    | Epoch timestamp when scale-up began            |
| `scaleUpRequested`    | N    | Number of instances requested in this scale-up |
| `scaleUpInstanceIds`  | L(S) | EC2 instance IDs launched for this action      |

### Scale-Up State Transitions

1. **Begin**: `beginScaleUp()`

   - Sets `scalingInProgress=true`
   - Writes `scaleUpActionId`, `scaleUpStartedEpoch`, `scaleUpRequested`
   - Clears `scaleUpInstanceIds`
   - **Conditional write** prevents concurrent scaling

2. **Record**: `recordScaleUpInstances()`

   - Writes `scaleUpInstanceIds`
   - Condition: only allowed if `scaleUpActionId` matches

3. **Verify**: join verification in subsequent invocations

   - Ensures nodes become Ready (via Prometheus readiness queries)

4. **Complete**: `completeScaleUp()`

   - Sets `scalingInProgress=false`
   - Sets `lastScaleEpoch=now`
   - Removes scale-up fields

5. **Fail**: `failScaleUp()`
   - Clears scale-up fields and resets `scalingInProgress=false`
   - Used after join timeout or unrecoverable verification failure

---

## Scale-Down Tracking Fields (New)

Scale-down is implemented as a tracked, resumable action to handle Lambda failures mid-operation.

| Attribute                       | Type | Description                                                                   |
| ------------------------------- | ---- | ----------------------------------------------------------------------------- |
| `scaleDownActionId`             | S    | Unique scale-down action identifier                                           |
| `scaleDownStartedEpoch`         | N    | Epoch timestamp when scale-down began                                         |
| `scaleDownPhase`                | S    | Phase string: `DRAINING` or `TERMINATING` (optional but useful for debugging) |
| `scaleDownTargetInstanceIds`    | L(S) | Instance IDs selected for removal (the plan)                                  |
| `scaleDownCompletedInstanceIds` | L(S) | Instance IDs already successfully terminated (progress)                       |

### Why These Fields Exist

Scale-down is a multi-step process (cordon → drain → terminate). Lambda may fail or time out mid-way. Without durable tracking, the system can:

- Drain the same node repeatedly
- Lose progress after partial success
- Thrash nodes due to incorrect cooldown handling

These fields make scale-down **idempotent** and **resumable**.

---

## Scale-Down Workflow

### 1) Begin Scale-Down (Persist the Plan)

`beginScaleDown()` stores the plan before any destructive actions occur:

- Sets `scalingInProgress=true`
- Writes `scaleDownActionId`, `scaleDownStartedEpoch`
- Sets `scaleDownPhase="DRAINING"`
- Writes the list of `scaleDownTargetInstanceIds`
- Initializes `scaleDownCompletedInstanceIds=[]`

**ConditionExpression:**

- Only begins if `scalingInProgress` is false

This prevents concurrent scale-down operations and ensures the plan is durable.

---

### 2) Execute Scale-Down (Idempotent Progress)

For each target instance ID:

- If instance is already in `scaleDownCompletedInstanceIds`, skip it
- Drain the Kubernetes node (cordon + eviction loop)
- Terminate the EC2 instance
- Record progress by appending that instanceId to `scaleDownCompletedInstanceIds`

`markScaleDownInstanceDone()` uses an update that is safe across retries.

---

### 3) Resume Scale-Down (Recovery)

If a Lambda invocation crashes mid-scale-down:

- Next scheduled invocation loads state
- Detects `scalingInProgress=true` and `scaleDownActionId` present
- Resumes remaining instance IDs in `scaleDownTargetInstanceIds`
- Skips already completed ones via `scaleDownCompletedInstanceIds`

This prevents duplicate actions and preserves partial progress.

---

### 4) Complete Scale-Down (Commit Cooldown + Clear Fields)

`completeScaleDown()` finalizes scale-down:

- Sets `scalingInProgress=false`
- Sets `lastScaleEpoch=now`
- Removes all scale-down fields

---

### 5) Fail / Clear Scale-Down (Deadlock Recovery)

If the scale-down action is stuck beyond a safety threshold (e.g., > 15 minutes), the autoscaler can clear it with `failScaleDown()`:

- Sets `scalingInProgress=false`
- Removes all scale-down fields

This prevents permanent deadlock.

---

## Example State Items

### Idle / No Scaling Active

```json
{
  "pk": "cluster",
  "scalingInProgress": false,
  "lastScaleEpoch": 1730000000,
  "pendingSinceEpoch": 0,
  "idleSinceEpoch": 1730000100,
  "workerCount": 2
}
```

### Scale-Up In Progress

```json
{
  "pk": "cluster",
  "scalingInProgress": true,
  "lastScaleEpoch": 1730000000,
  "scaleUpActionId": "1730000300-req-xyz",
  "scaleUpStartedEpoch": 1730000300,
  "scaleUpRequested": 2,
  "scaleUpInstanceIds": ["i-aaa", "i-bbb"]
}
```

### Scale-Up In Progress

```json
{
  "pk": "cluster",
  "scalingInProgress": true,
  "lastScaleEpoch": 1730000000,
  "scaleUpActionId": "1730000300-req-xyz",
  "scaleUpStartedEpoch": 1730000300,
  "scaleUpRequested": 2,
  "scaleUpInstanceIds": ["i-aaa", "i-bbb"]
}
```

## Design Summary

This state model is intentionally conservative and explicit:

- Conditional writes prevent concurrent scaling
- Action IDs enforce correctness across retries
- Scale-down is resumable and idempotent
- Cooldown timestamps are updated only on successful completion
- State fields are cleared after completion to keep the record minimal

This approach handles real-world failure modes (timeouts, retries, partial success) without requiring an external workflow engine.
