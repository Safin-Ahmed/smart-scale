# Prometheus – Component Specification

## Purpose

Prometheus provides **real-time cluster observability** and supplies the autoscaler
with metrics required for scaling decisions.

---

## Deployment Model

- Installed using `kube-prometheus-stack`
- Exposed via **NodePort**
- Scheduled **only on the master node**
- Master node is tainted to prevent application workloads

This design ensures:

- Metrics availability during worker scale-down
- Stable observability endpoint
- No dependency on worker nodes for metrics

---

## Key Metrics Collected

### CPU Utilization

```promql
avg(rate(node_cpu_seconds_total{mode!="idle"}[5m]))
```

### Pending Pods

```promql
sum(kube_pod_status_phase{phase="Pending"})
```

### Node Readiness

```promql
kube_node_status_condition{condition="Ready", status="true"}
```

<br/>

# Design Rationale

- NodePort avoids in-cluster authentication complexity
- Lambda accesses Prometheus directly over VPC networking
- Master node is never deprovisioned, guaranteeing availability
