# State Management & Distributed Locking

This document explains how the autoscaler maintains state and prevents race
conditions when multiple Lambda invocations run concurrently.

---

## DynamoDB as the Source of Truth

A single DynamoDB table stores cluster-wide autoscaler state.

### Table: `k3s-autoscaler-state`

**Partition Key**

- `pk` (String) → always set to `"cluster"`

---

## State Attributes

| Attribute           | Type    | Purpose                            |
| ------------------- | ------- | ---------------------------------- |
| scalingInProgress   | Boolean | Prevents concurrent scaling        |
| lastScaleEpoch      | Number  | Enforces cooldowns                 |
| lockOwner           | String  | Lambda request ID holding the lock |
| lockUntilEpoch      | Number  | Lock expiry timestamp              |
| scaleUpActionId     | String  | Unique ID for scale-up operation   |
| scaleUpInstanceIds  | List    | EC2 instances launched             |
| scaleUpStartedEpoch | Number  | Join verification timeout tracking |
| workerCount         | Number  | Last known worker count            |

---

## Distributed Lock Mechanism

Scaling operations require acquiring a **DynamoDB conditional lock**.

### Lock Acquisition

A lock is acquired using a conditional update:

attribute_not_exists(scalingInProgress)
OR scalingInProgress = false
OR lockUntilEpoch < now

yaml
Copy code

This ensures:

- Only one scaling operation runs at a time
- Locks automatically expire if Lambda crashes

---

## Lock Expiry & Recovery

- Each lock has a TTL (`lockUntilEpoch`)
- If a Lambda crashes or times out:
  - The lock expires automatically
  - Next invocation can recover safely

---

## Two-Phase Scale-Up State

Scale-up is modeled as a **two-phase operation**:

### Phase 1: Launch

- Lock acquired
- Instances launched
- Instance IDs recorded
- scalingInProgress = true

### Phase 2: Verify Join

- Lambda checks if instances joined K3s
- If success → completeScaleUp
- If timeout → failScaleUp (state reset)

This ensures correctness even across Lambda invocations.

---

## Why DynamoDB (Not Memory)

- Lambda is stateless
- Multiple concurrent invocations are possible
- DynamoDB guarantees atomic conditional writes
- Enables crash-safe recovery

---

## Summary

This locking and state model ensures:

- Idempotent scaling operations
- No double-scaling
- Safe recovery from partial failures
- Clear audit trail of scaling events
