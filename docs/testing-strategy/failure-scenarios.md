# Failure Scenarios & Resilience Testing

This document outlines how the system behaves under failure conditions.

---

## Design Philosophy

Failures are expected.

The system must:

- Fail safe
- Self-heal where possible
- Never corrupt cluster state

---

## Failure Scenarios

### 1. Prometheus Unavailable

**Scenario**

- Prometheus service unreachable

**Expected Behavior**

- Autoscaler returns `NOOP`
- No scale-up or scale-down

**Outcome**

- Safe inaction
- System recovers automatically when metrics return

---

### 2. DynamoDB Conditional Write Failure

**Scenario**

- Two autoscaler invocations race

**Expected Behavior**

- One succeeds, one fails conditionally
- Only one scale-up or scale-down occurs

**Outcome**

- No duplicate scaling
- State consistency preserved

---

### 3. Lambda Crash Mid-Execution

**Scenario**

- Lambda times out or crashes after launching instances

**Expected Behavior**

- State remains `scalingInProgress`
- Verification mode handles recovery
- Stuck states cleared after timeout

**Outcome**

- System recovers without manual intervention

---

### 4. Spot Interruption Event

**Scenario**

- Spot interruption or rebalance notice received

**Expected Behavior**

- Node cordoned and drained
- Instance terminated proactively
- Replacement launched (Spot → On-Demand fallback)

**Outcome**

- Minimal workload disruption
- Capacity restored quickly

---

### 5. Replacement Capacity Failure

**Scenario**

- Spot and On-Demand both unavailable

**Expected Behavior**

- Failure logged
- No infinite retry loops

**Outcome**

- Human intervention required
- System state remains consistent

---

### 6. K8s API Unreachable

**Scenario**

- Master temporarily unavailable

**Expected Behavior**

- Drain and scale operations fail safely
- No forced termination

**Outcome**

- Autoscaler waits for control plane recovery

---

## Failure Guarantees

| Guarantee           | Description              |
| ------------------- | ------------------------ |
| No data loss        | State always recoverable |
| No forced evictions | Without successful drain |
| No AZ collapse      | Even under failure       |
| No infinite loops   | Time-bounded retries     |

---

## Summary

The system is designed to **survive partial failure without cascading impact**.

Most failures result in:

> Safe inaction → Recovery → Resume normal operation
