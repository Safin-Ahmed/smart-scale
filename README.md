# SmartScale - K3s Autoscaler on AWS

 <br />

## Project Overview

SmartScale is an intelligent, Lambda supported autoscaler system for a self managed **K3s Kubernetes cluster running on AWS EC2**.

It dynamically provisions and deprovisions worker nodes based on real-time cluster demand, without relying on managed kubernetes services or cloud-native autoscalers. The system is designed with safety, correctness and cost efficiency as first-class concerns.

SmartScale is built for teams that want:

- Full control over their kubernetes infrastructure
- Predictable scaling behavior
- Lower cloud costs
- Clear visibility into scaling decisions

<br />

## Why SmartScale Exists

Running Kubernetes on raw EC2 gives flexibility but scaling becomes painful:

- Fixed worker counts waste money during off-peak hours
- Traffic spikes cause pod backlogs and outages
- Manual scaling is slow and error-prone
- Default cluster autoscalers hide too much logic and state

SmartScale solves this by implementing a transparent, auditable, and deterministic autoscaling pipeline that works directly with EC2 and K3s.

<br />

## Key Features

- Event-driven autoscaling using AWS Lambda
- Distributed lock and state management via DynamoDB
- Prometheus-driven, metric-based scaling decisions
- Automated EC2 worker provisioning
- Safe, graceful scale-down using cordon + drain
- Join verification before capacity is considered ready
- Cloud-aware behavior (AZ balancing, Spot interruptions)
- Full Infra as Code (PULUMI)
- No hardcoded credentials, least-privilege IAM

<br />

## Architecture

**Core Components**

- **AWS Lambda (VPC-enabled)**<br />
  Executes autoscaling logic on a fixed schedule
- **Amazon DynamoDB**<br />
  Executes autoscaling logic on a fixed schedule
- **Prometheus (in-cluster)**<br />
  Provides real-time CPU, memory, and pod level metrics
- **Amazon EC2**<br/>
  Hosts the K3s control plane and dynamically managed worker nodes
- **EventBridge**<br />
  Triggers autoscaler evaluation at regular intervals (2 mins)

<br />

## Scaling Workflow

1. Lambda is triggered on a schedule
2. A distributed lock is acquired in DynamoDB
3. Cluster metrics are fetched from Prometheus
4. Scaling decision is evaluated
5. One of the following happens based on decision: <br />
   Scale Up: Launch EC2 workers -> auto-join k3s -> verify readiness <br/>
   Scale Down: Cordon node -> drain workloads -> terminate EC2 instance <br />
   No-op: Conditions not met
6. State and decision logs are persisted
7. Lock is released safely

<br />

## Scaling Logic

**Scale Up Triggers (any)**

- Average CPU usage > 70% (sustained)
- Pending pods exist for > 3 minutes
- Memory utilization > 75%

**Scale Down Triggers (all)**

- Average CPU usage < 30% for 10 minutes
- No Pending Pods
- Memory utilization < 50%

<br />

## Constraints

| Parameter           | Value      |
| ------------------- | ---------- |
| Min workers         | 2          |
| Max workers         | 10         |
| Scale-up batch      | 1-2 nodes  |
| Scale-down batch    | 1 node     |
| Scale-up cooldown   | 5 minutes  |
| Scale-down cooldown | 10 minutes |

<br />

## Safety & Correctness Guarantees

**Distributed Locking**

- DynamoDB conditional writes prevent concurrent scaling
- Lock TTL ensures recovery from Lambda timeouts
- Idempotent scaling actions using action IDs

<br />

## Join Verification

- Newly launched nodes are not trusted immediately
- Nodes must appear as Ready in Kubernetes
- Verified via kubernetes api
- Failed joins are automatically cleaned up

<br />

## Graceful Scale Down

- Node is cordoned before removal
- Pods are drained with a timeout
- System-critical workloads are protected
- Instance termination only happens after drain success

<br />

## Metrics Used (Prometheus)

- Average CPU usage <br />
  avg(rate(node_cpu_seconds_total{mode!="idle"}[2m]))
- Pending pods <br />
  sum(kube_pod_status_phase{phase="Pending"})
- Sustained pending pods <br />
  min_over_time((sum(kube_pod_status_phase{phase="Pending"})) > 0 [3m:])
- Memory utilization <br />
  avg(node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

<br />

## State Management (DynamoDB)

**State Table** <br />
Tracks:

- Scaling in progress
- Last scaling timestamp
- Active scale-up action
- Instances awaiting verification

**Logs Table** <br />
Stores:

- Scaling decisions
- Metrics snapshots
- Launch and termination events
- Error diagnostics

This makes scaling behavior fully auditable.

<br />

## Infrastructure as Code

All infrastructure is defined using Pulumi (TypeScript)

- VPC, subnets, routing
- Security groups
- EC2 instances and launch configuration
- IAM roles and policies
- Lambda function
- DynamoDB tables
- VPC endpoints

The entire system can be recreated from scratch deterministically.

## Testing & Validation

**Scale-Up Test**

```bash
kubectl scale deploy app --replicas=50
```

**Scale-Down Test**

```bash
kubectl scale deploy app --replicas=2
```

**Failure Scenarios Handled**

- Lambda timeout during scaling
- Prometheus temporarily unavailable
- EC2 launch failures
- Stuck distributed lock
- Node join failures

<br />

## Cost Efficiency

- Scales down aggressively during low utilization
- Scales up only when sustained pressure exists
- Avoids over-provisioning
- Designed to reduce EC2 costs by 40%-50% in typical workloads

<br />

## Security Model

- No embedded AWS credentials
- IAM roles with least privilege
- Lambda runs inside VPC
- Prometheus access restricted via security groups
- Encrypted EC2 volumes

<br />
<br />

# Limitations & Trade-offs

- Cloudwatch dashboards intentionally not used, instead we stored logs in dynamodb for fast and efficient access.
- Prometheus exposed via NodePort (network-restricted)
- Predictive scaling not yet implemented

These trade-offs were made consciously to keep the system simple, auditable and portable.

<br />

## Improvement Plans

- Predictive scaling
- Grafana-based scaling dashboards
- Slack notifications

<br />

## Author

**Safin Ahmed**<br />
Sr. Software Engineer
