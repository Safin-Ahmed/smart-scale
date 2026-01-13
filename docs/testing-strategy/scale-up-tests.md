# Scale-Up Testing Strategy

This document describes how scale-up behavior is validated under normal and stressed conditions.

---

## Objectives

The goal of scale-up testing is to ensure that:

- The autoscaler reacts only to **sustained pressure**
- Scale-up happens **once per event**, not repeatedly
- New workers reliably join the cluster
- Capacity is added **before workloads are starved**

---

## Preconditions

- Minimum workers running (`MIN_WORKERS`)
- Prometheus healthy and reachable
- Autoscaler Lambda scheduled via EventBridge
- No scaling currently in progress

---

## Test Cases

### 1. Sustained CPU Pressure

**Setup**

- Deploy CPU-intensive pods on workers
- Ensure CPU > `CPU_UP` threshold

**Expected Behavior**

- Autoscaler waits `PENDING_UP_SEC`
- Scale-up decision triggered
- 1–2 workers launched (bounded by `MAX_BATCH_UP`)
- No duplicate scale-ups due to locking

**Validation**

- DynamoDB `scalingInProgress=true`
- New EC2 instances created
- Nodes appear as `Ready` in K3s
- `completeScaleUp` clears scale-up state

---

### 2. Pending Pods Trigger

**Setup**

- Deploy pods that exceed current scheduling capacity
- Observe `Pending` state

**Expected Behavior**

- Autoscaler detects pending pods
- Scale-up triggered even if CPU is moderate
- New capacity added before timeout

**Validation**

- Prometheus shows reduced pending pods
- New nodes join and accept workloads

---

### 3. Join Verification Failure

**Setup**

- Block worker join (invalid token or security group)
- Force scale-up

**Expected Behavior**

- Workers launch but do not join
- Autoscaler enters verification mode
- After `JOIN_TIMEOUT_SEC`, scale-up fails safely

**Validation**

- `failScaleUp` clears stuck state
- No infinite `scalingInProgress`
- Subsequent scale-ups allowed

---

### 4. Cooldown Enforcement

**Setup**

- Trigger a scale-up
- Maintain pressure briefly afterward

**Expected Behavior**

- No additional scale-up during `COOLDOWN_UP_SEC`

**Validation**

- Decision logged as `NOOP`
- No new EC2 launches

---

## Success Criteria

- No duplicate scale-ups
- No missed scale-ups under sustained load
- State transitions are correct and recoverable
