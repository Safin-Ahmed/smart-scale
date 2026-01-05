# Scale-Up Flow

This document describes the full lifecycle of a scale-up operation.

---

## Overview

Scale-up is intentionally split into **launch** and **verification** phases to
handle partial failures safely.

---

## Step-by-Step Flow

### 1. Lambda Invocation

Triggered by EventBridge (or manual invocation).

---

### 2. Load Current State

- Reads DynamoDB state
- If scalingInProgress → enters verification mode

---

### 3. Fetch Metrics

- Query Prometheus via NodePort
- CPU, pending pods, sustained pending

---

### 4. Decision Phase

- Run decision engine
- Decide SCALE_UP or NOOP

---

### 5. Acquire Lock

- Conditional update in DynamoDB
- Prevents concurrent scaling

---

### 6. Begin Scale-Up

- Mark scalingInProgress = true
- Generate scaleUpActionId
- Record start timestamp

---

### 7. Launch EC2 Workers

- Use RunInstances API
- Inject K3s join config via user data
- Tag instances for cluster discovery

---

### 8. Record Instance IDs

- Persist launched instance IDs in DynamoDB
- Enables verification across invocations

---

### 9. Verification Phase (Next Invocation)

- Lambda runs again
- Uses SSM on master node
- Executes `kubectl get nodes`
- Verifies nodes are Ready

---

### 10. Completion or Recovery

- If all nodes Ready → completeScaleUp
- If timeout exceeded → failScaleUp
- Lock released automatically

---

## Failure Handling

| Failure              | Handling             |
| -------------------- | -------------------- |
| Lambda timeout       | Lock expiry          |
| EC2 launch failure   | Partial recovery     |
| Join failure         | Timeout-based reset  |
| Duplicate invocation | Lock prevents action |

---

## Summary

This flow guarantees:

- No orphaned instances
- No double scaling
- Deterministic recovery
- Safe asynchronous scaling
