# K3s AutoScaler (AWS)

A production-grade, event-driven autoscaler for a K3s cluster running on AWS EC2.

This project implements **safe scale-up, safe scale-down, multi-AZ awareness, and Spot instance interruption handling** without relying on managed Kubernetes services or built-in autoscalers.

---

## Objectives

The primary goals of this system are:

- Automatically scale worker nodes based on real Kubernetes metrics
- Guarantee safe node deprovisioning (no workload loss)
- Maintain high availability across multiple Availability Zones
- Leverage Spot instances safely with automatic fallback
- Keep observability infrastructure stable and isolated

This design favors **correctness and safety over aggressive scaling**.

---

## High-Level Architecture

**Core components:**

- **K3s Cluster**
  - 1× Control Plane (Master)
  - N× Worker Nodes (Spot + On-Demand)
- **Prometheus**
  - Deployed inside cluster
  - Pinned to master node
- **Autoscaler (AWS Lambda)**
  - Poll-based scaling
  - Event-driven interruption handling
- **DynamoDB**
  - State management
  - Distributed locking
- **AWS EC2**
  - Worker lifecycle management
- **AWS SSM Parameter Store**
  - Secure token storage

---

## Key Design Decisions

### 1. Master Node Is Never Deprovisioned

- Hosts:
  - Kubernetes control plane
  - Prometheus monitoring stack
- Tainted to prevent application workloads
- Guarantees observability and API availability during scaling events

---

### 2. Metrics-Driven Autoscaling

Scaling decisions are based on:

- Average CPU utilization
- Pending pod count
- Duration-based thresholds (not instantaneous spikes)

All decisions are **time-aware and stateful**.

---

### 3. Safe Scale-Down (Hard Requirement)

Scale-down strictly follows these rules:

- Nodes are **cordoned first**
- Pods are **gracefully evicted**
- Drain timeout enforced (5 minutes)
- Nodes with critical system pods are **never terminated**
- Minimum worker count is always respected

If any safety check fails → **NOOP**.

---

### 4. Multi-AZ Awareness (Bonus)

- Workers are evenly distributed across AZs
- Scale-up always targets the **least populated AZ**
- Scale-down avoids draining an AZ to zero when possible

This ensures resilience against AZ-level failures.

---

### 5. Spot Instance Support with Interruption Handling (Bonus)

- Workers are launched as **Spot-first**
- Automatic fallback to On-Demand if Spot capacity is unavailable
- Spot interruption events trigger:
  - Immediate graceful drain
  - Proactive termination
  - AZ-aware replacement launch

This makes Spot usage **safe and predictable**.

---

## Autoscaler Execution Model

### Poll-Based Scaling

- Triggered every 2 minutes via EventBridge
- Evaluates metrics and cluster state
- Executes **at most one scaling action at a time**

### Event-Driven Handling

- Listens for:
  - EC2 Spot Interruption Warnings
  - EC2 Rebalance Recommendations
- Handles node replacement immediately, outside normal polling flow

---

## State Management (DynamoDB)

A single DynamoDB record maintains cluster state:

- Scaling in progress flag
- Last scale timestamp
- Pending/idle tracking
- Active scale-up action metadata

Conditional writes + distributed locking guarantee:

- No double scaling
- No race conditions
- Safe recovery from failures

---

## Security Model

- Cluster join token stored in **SSM Parameter Store**
- Kubernetes API token minted via ServiceAccount
- Lambda has **least-privilege IAM**
- No secrets baked into AMIs or code

---

## Observability

### Metrics

- Collected via Prometheus
- Queried directly by autoscaler

### Dashboards

- Cluster health
- Autoscaling decisions
- AZ distribution
- Spot stability

### Alerts

- Autoscaler failures
- Join timeouts
- Drain failures
- Spot replacement failures

No alert noise. Only actionable signals.

---

## Folder Structure

K3S-AUTOSCALER
├── autoscaler/
│ ├── adapters/
│ ├── core/
│ └── lambda/
│ └── handler.ts
├── infra/
│ ├── pulumi/
│ └── k8s/
├── services/
│ └── checkout/
├── docs/
│ ├── architecture.md
│ ├── scaling-algorithm.md
│ ├── design.md
│ ├── component-specifications/
│ ├── monitoring-and-alerting/
│ ├── testing-strategy.md
│ └── bonus/
└── README.md

---

## What This Is (and Isn’t)

**This is:**

- A real autoscaler implementation
- Safe, explainable, and deterministic
- Suitable for small-to-medium clusters

**This is not:**

- A replacement for managed kubernetes service
- Tied to managed Kubernetes services auto-scaling

---

## Final Notes

This project intentionally prioritizes:

- **Safety over speed**
- **Correctness over cleverness**
- **Operational clarity over abstraction**

Every scaling decision can be explained after the fact, and that’s the point.

## Bonus Challenges

<br />

### Implemented

- **Multi-AZ awareness** for both scale-up and scale-down, ensuring balanced capacity and zone-level resilience
- **Spot instance usage with graceful interruption handling**, including fast drain, proactive termination, and AZ-aware on-demand fallback

### Not Implemeneted (Future Improvements)

- Predictive pre-scaling using historical workload trends
- Custom application level metrics (queue depth, latency, error rates)
- GitOps-style configuration management with versioned rollouts
- Pluggable notification system (e.g., Slack, webhooks, incident tools)

---

**Author:** Safin  
**Role:** Senior Software Engineer  
**Focus:** Systems, reliability, and pragmatic design
