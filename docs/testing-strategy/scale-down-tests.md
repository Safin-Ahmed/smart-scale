# Scale-Down Testing Strategy

This document defines how scale-down behavior is validated to ensure safety and correctness.

---

## Objectives

Scale-down must be:

- Conservative
- Safe for workloads
- Resistant to flapping
- Aware of multi-AZ topology

---

## Preconditions

- Worker count > `MIN_WORKERS`
- CPU below `CPU_DOWN` threshold
- Cluster idle for `IDLE_DOWN_SEC`
- No scaling currently in progress

---

## Test Cases

### 1. Idle-Based Scale-Down

**Setup**

- Remove workload pressure
- Allow CPU to drop below threshold

**Expected Behavior**

- Autoscaler waits `IDLE_DOWN_SEC`
- Selects oldest workers first
- Drains workloads gracefully

**Validation**

- `gracefulDrain` completes successfully
- Instance terminated only after drain
- `recordScaleDown` updates last scale time

---

### 2. Drain Timeout Safety

**Setup**

- Run pods with long shutdown times
- Trigger scale-down

**Expected Behavior**

- Drain attempts until `DRAIN_TIMEOUT_SEC`
- Scale-down aborted if timeout reached

**Validation**

- No EC2 termination
- Decision logged as `drainTimeout`
- Cluster remains stable

---

### 3. Critical Pod Protection

**Setup**

- Place critical pods (`kube-system`, non-DaemonSet)
- Attempt scale-down

**Expected Behavior**

- Autoscaler detects critical pods
- Scale-down aborted immediately

**Validation**

- No termination
- Reason logged clearly
- Human action required to fix placement

---

### 4. Multi-AZ Safe Removal

**Setup**

- Workers spread across multiple AZs
- Trigger scale-down

**Expected Behavior**

- Autoscaler removes from most-populated AZ first
- Never drains an AZ to zero if others exist

**Validation**

- AZ distribution remains balanced
- No single-AZ collapse

---

## Success Criteria

- No workload disruption
- No control-plane risk
- No AZ imbalance introduced
