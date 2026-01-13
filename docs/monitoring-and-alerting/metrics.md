# Metrics Collection – Component Specification

This document describes how metrics are collected, exposed, and consumed by the autoscaler.

---

## Metrics Source

The system uses **Prometheus** deployed via `kube-prometheus-stack` as the single source of truth for cluster metrics.

Key characteristics:

- Deployed **inside the K3s cluster**
- Scrapes:
  - Kubelet metrics
  - cAdvisor metrics
  - Kubernetes API metrics
- Exposed externally via **NodePort**

---

## Prometheus Deployment Model

### Placement Strategy

- Prometheus is **pinned to the master node only**
- The master node is:
  - Labeled: `nodepool=monitoring`
  - Tainted: `node-role.kubernetes.io/control-plane=NoSchedule`

This ensures:

- Monitoring infrastructure is **never evicted**
- Autoscaling decisions do not affect observability
- Worker scale-down cannot accidentally remove Prometheus

---

## Prometheus Access

Prometheus is exposed using:

```yaml
prometheus:
  service:
    type: NodePort
    nodePort: 30900
```

The autoscaler Lambda queries Prometheus at:
http://<master-private-ip>:30900

## Metrics Used by the Autoscaler

### 1. Average CPU Utilization

Used to determine scale-up and scale-down triggers.

Query (conceptual):

```
avg(node_cpu_utilization)
```

**Purpose:**

- High sustained CPU → scale up

- Low sustained CPU → candidate for scale down

### 2. Pending Pods Count

Used to detect scheduling pressure.

Query (conceptual):

```
count(kube_pod_status_phase{phase="Pending"})
```

Purpose:

- Pending pods indicate insufficient capacity

- Drives proactive scale-up before SLA impact

### 3. Pending Duration

Used to avoid reacting to short-lived spikes.

Logic:

- Pending pods must persist longer than PENDING_UP_SEC

- Prevents noisy or flapping scale-up decisions

4. Idle Duration

Used to validate scale-down safety.

Logic:

- CPU below threshold for IDLE_DOWN_SEC

- Ensures cluster is truly underutilized before scale-down

<br />

### Metric Evaluation Window

All decisions are time-aware, not instantaneous:

| Metric       | Purpose                | Time Bound       |
| ------------ | ---------------------- | ---------------- |
| CPU          | Utilization trend      | Continuous       |
| Pending pods | Capacity pressure      | ≥ PENDING_UP_SEC |
| Idle state   | Scale-down eligibility | ≥ IDLE_DOWN_SEC  |

This design avoids oscillation and thrashing.

---

<br />

### Why Prometheus (and Not CloudWatch)?

- Kubernetes-native metrics (pods, nodes, scheduling)

- Lower latency for autoscaling decisions

- No dependency on AWS-specific metrics

- Works identically across Spot and On-Demand instances

---

<br />

### Failure Characteristics

If Prometheus is temporarily unavailable:

- Autoscaler safely returns NOOP

- No scale-up or scale-down occurs

- System remains stable until metrics recover

This is an explicit fail-safe design choice.
