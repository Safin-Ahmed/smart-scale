# Alerts – Monitoring & Safety Signals

This document describes the alerting strategy for the autoscaler system.

Alerts are designed to be **actionable**, **minimal**, and **high-signal**.

---

## Alerting Philosophy

Alerts are triggered only when **human intervention may be required**.

The system intentionally avoids alerting on:

- Expected autoscaling behavior
- Short-lived metric spikes
- Normal Spot interruptions

---

## Alert Categories

### 1. Autoscaler Health Alerts

#### Autoscaler Not Running

**Trigger:**

- No autoscaler Lambda invocation within expected window

**Severity:** Critical

**Action:**

- Investigate EventBridge trigger
- Check Lambda errors/logs

---

### 2. Scale-Up Failure Alerts

#### Scale-Up Join Timeout

**Trigger:**

- Workers launched but not joining cluster within `JOIN_TIMEOUT_SEC`

**Severity:** High

**Action:**

- Inspect EC2 instances
- Check K3s agent logs
- Validate cluster token

---

### 3. Scale-Down Safety Alerts

#### Drain Failure Due to Critical Pods

**Trigger:**

- Scale-down aborted because critical system pods were detected

**Severity:** Warning

**Action:**

- Inspect pod placement
- Verify workloads respect node taints and tolerations

---

### 4. Spot Interruption Alerts

#### Spot Interruption With Failed Replacement

**Trigger:**

- Spot interruption handled but replacement launch fails

**Severity:** High

**Action:**

- Inspect EC2 capacity errors
- Validate fallback to On-Demand

---

### 5. Capacity Risk Alerts

#### Pending Pods Persisting Too Long

**Trigger:**

- Pending pods exceed `PENDING_UP_SEC`
- Autoscaler unable to scale (max reached or error)

**Severity:** High

**Action:**

- Increase max workers
- Investigate scheduling constraints

---

## Alert Delivery

Alerts are designed to be sent to:

- Slack (preferred)
- Email (optional)

Slack integration is intentionally decoupled and can be added without modifying autoscaler logic.

---

## What Is _Not_ Alerted

| Condition                | Reason            |
| ------------------------ | ----------------- |
| Normal scale-up          | Expected behavior |
| Normal scale-down        | Expected behavior |
| Single Spot interruption | Self-healing      |
| Short CPU spikes         | Noise             |

---

## Alert Fatigue Prevention

- Time-based thresholds
- State-aware alerts
- Autoscaler cooldowns respected

This ensures alerts are **rare, meaningful, and trusted**.
