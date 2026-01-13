# Scale-Down Safety Guarantees

Scale-down is the most dangerous operation in autoscaling.
This system enforces multiple safety layers:

## Kubernetes Safety

- Nodes are cordoned before draining
- DaemonSet pods are ignored
- Mirror/static pods are never evicted
- Priority classes `system-node-critical` and `system-cluster-critical` block termination
- Non-DaemonSet kube-system pods block termination

## Time Safety

- Drain timeout is capped at 5 minutes
- Spot interruption drains use a stricter ~2 minute timeout
- Timeouts abort termination, never force it

## Cluster Safety

- Minimum worker count enforced
- AZ-aware draining avoids single-AZ collapse
- Distributed lock prevents concurrent scale actions

The system always prefers **doing nothing** over doing something unsafe.
