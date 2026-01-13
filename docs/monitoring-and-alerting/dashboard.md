---

## 📄 `dashboard.md`

```md
# Dashboards – Observability Design

This document describes the dashboards used to visualize cluster health, autoscaling behavior, and system stability.

---

## Dashboard Philosophy

Dashboards are designed to answer **three operational questions**:

1. Is the cluster healthy?
2. Why did the autoscaler make a decision?
3. Is the system stable over time?

Dashboards are **diagnostic tools**, not vanity charts.

---

## Primary Dashboards

### 1. Cluster Capacity Overview

**Purpose:** High-level health snapshot

**Panels:**

- Node count (total / per AZ)
- Average CPU utilization
- Pending pod count
- Running pod count

**Operator Use Case:**

- Quickly assess whether the cluster is overloaded or idle

---

### 2. Autoscaler Decision Dashboard

**Purpose:** Explain _why_ scaling happened

**Panels:**

- CPU utilization vs thresholds
- Pending pods over time
- Idle duration timeline
- Scale-up / scale-down events (annotations)

**Operator Use Case:**

- Validate autoscaler behavior
- Debug unexpected scaling actions

---

### 3. Multi-AZ Distribution Dashboard

**Purpose:** Ensure fault tolerance

**Panels:**

- Workers per Availability Zone
- AZ imbalance over time
- Scale events per AZ

**Operator Use Case:**

- Confirm AZ-aware logic is working
- Detect AZ skew before failures occur

---

### 4. Spot Instance Stability Dashboard

**Purpose:** Spot reliability and churn visibility

**Panels:**

- Spot vs On-Demand worker count
- Spot interruption events
- Replacement latency

**Operator Use Case:**

- Validate interruption handling
- Ensure replacement capacity is fast and safe

---

## Dashboard Characteristics

- Built on **Prometheus metrics**
- Designed for **read-only access**
- No dashboards are required for autoscaler operation
- Dashboards do not influence control-plane logic

---

## Why Dashboards Matter in This Design

- Autoscaling is **stateful and time-based**
- Decisions must be explainable post-fact
- Dashboards provide:
  - Confidence
  - Debuggability
  - Auditability

This is especially critical for Spot-based systems.

---

## Non-Goals

- No per-pod micro-optimizations
- No business-level KPIs
- No alert fatigue via excessive charts

Dashboards serve operators — not metrics collectors.
