# Scale-Down Flow

This document describes the design and intended behavior of the scale-down
process.

---

## Design Goals

- Avoid disrupting workloads
- Drain nodes safely
- Maintain minimum capacity
- Prevent accidental cluster degradation

---

## High-Level Strategy

Scale-down is **deliberately conservative**.

Only one node is removed at a time, and only after the cluster has been idle for
a sustained period.

---

## Scale-Down Conditions

All must be true:

- CPU usage ≤ 30%
- No pending pods
- Idle duration ≥ 10 minutes
- Worker count > MIN_WORKERS
- No scaling operation in progress

---

## Node Selection Strategy

Candidate node selection (in priority order):

1. Nodes with lowest pod count
2. Nodes without system-critical pods
3. Nodes with oldest uptime

Stateful workloads and protected pods are excluded.

---

## Planned Scale-Down Steps

1. Acquire scaling lock
2. Select candidate worker node
3. Cordon node (`kubectl cordon`)
4. Drain node with timeout (`kubectl drain`)
5. Verify pod eviction
6. Terminate EC2 instance
7. Update DynamoDB state
8. Release lock

---

## Safety Measures

- PodDisruptionBudgets respected
- Drain timeout enforced
- Minimum worker count enforced
- One-node-at-a-time policy

---

## Current Status

⚠️ **Scale-down logic implemented but not yet fully validated in production**

Future improvements:

- Automated validation tests
- StatefulSet-aware draining
- Zone-aware balancing

---

## Summary

Scale-down prioritizes safety over aggressiveness.
The system intentionally prefers running slightly hot rather than risking
service disruption.
