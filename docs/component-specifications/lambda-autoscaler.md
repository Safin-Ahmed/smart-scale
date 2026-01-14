# Lambda Autoscaler – Component Specification

## Purpose

The Lambda Autoscaler acts as the **control plane** of the system.  
It continuously evaluates cluster state and makes safe, serialized scaling decisions.

Its responsibilities include:

- Collecting metrics from Prometheus
- Deciding scale-up and scale-down actions
- Launching and terminating EC2 worker nodes
- Gracefully draining Kubernetes workloads
- Handling EC2 Spot interruption events
- Enforcing strong consistency using DynamoDB-based locks

The function is **stateless by design**; all durable state is stored in DynamoDB.

---

## Invocation Sources

| Source                   | Purpose                                  |
| ------------------------ | ---------------------------------------- |
| EventBridge (rate-based) | Periodic autoscaling evaluation          |
| EventBridge (EC2 events) | Spot interruption and rebalance handling |

---

## High-Level Scaling Flow (Pseudocode)

```text
handler(event):
  if event is Spot Interruption:
    handleSpotEvent(event)
    return

  metrics = fetchPrometheusMetrics()
  state = loadDynamoState()

  decision = decideScale(metrics, state)

  if decision == NOOP:
    log decision
    return

  acquireDistributedLock()

  if decision == SCALE_UP:
    chooseAZs()
    launchWorkers()
    recordState()

  if decision == SCALE_DOWN:
    pickSafeTargets()
    drainNodes()
    terminateInstances()
    recordState()

  releaseLock()
```

## Environment Variables

### Scaling Configuration

| Variable          | Description                          |
| ----------------- | ------------------------------------ |
| CPU_UP            | CPU threshold for scale-up           |
| CPU_DOWN          | CPU threshold for scale-down         |
| PENDING_UP_SEC    | Pending pod duration before scale-up |
| IDLE_DOWN_SEC     | Idle duration before scale-down      |
| MIN_WORKERS       | Minimum worker count                 |
| MAX_WORKERS.      | Maximum worker count                 |
| COOLDOWN_UP_SEC   | Scale-up cooldown                    |
| COOLDOWN_DOWN_SEC | Scale-down cooldown                  |

### Cluster & Networking

| Variable                | Description                            |
| ----------------------- | -------------------------------------- |
| MASTER_TAG_KEY          | Tag key identifying the master node    |
| MASTER_TAG_VALUE        | Tag value identifying the master node  |
| WORKER_TAG_KEY          | Tag key for worker nodes               |
| WORKER_TAG_VALUE        | Tag value for worker nodes             |
| WORKER_SUBNET_IDS       | Comma-separated list of worker subnets |
| WORKER_SG_ID            | Worker security group ID               |
| WORKER_INSTANCE_PROFILE | IAM instance profile for workers       |
| WORKER_KEY_NAME         | EC2 SSH key name                       |

### Security & Secrets

| Variable                | Description                            |
| ----------------------- | -------------------------------------- |
| K3S_CLUSTER_TOKEN_PARAM | SSM parameter for cluster join token   |
| K8S_API_TOKEN_PARAM     | SSM parameter for Kubernetes API token |

### Observability

| Variable      | Description          |
| ------------- | -------------------- |
| PROM_NODEPORT | Prometheus NodePort  |
| STATE_TABLE   | DynamoDB state table |
| LOGS_TABLE    | DynamoDB logs table  |

# IAM Permissions (Summary)

The Lambda IAM role allows:

- DynamoDB

  - GetItem, PutItem, UpdateItem

- EC2

  - DescribeInstances
  - RunInstances
  - TerminateInstances

- SSM

  - GetParameter (SecureString)

- KMS

  - Decrypt SecureString parameters

- EventBridge
  - Lambda invocation

IAM access follows least-privilege principles.

**NOTE**: EventBridge rules (scheduled + spot events) require IAM permissions that may be unavailable in restricted lab accounts.

---

# Fault Tolerance & Safety

- DynamoDB-based distributed locking

- Idempotent scaling operations

- Join-timeout protection for scale-up

- Drain-timeout enforcement for scale-down

- Master node explicitly excluded from deprovisioning
