# Bonus: Spot Instances & Interruption Handling

## Problem

Spot instances are cost-effective but unreliable.
Without interruption handling, sudden termination can cause workload disruption.

## Solution Overview

This autoscaler treats Spot interruptions as first-class events and reacts in real time.

## Default Behavior

- Worker nodes are launched as **Spot instances by default**
- On-demand instances are used only as fallback

## Interruption Handling Flow

1. AWS emits a Spot interruption or rebalance event
2. EventBridge invokes the autoscaler Lambda
3. A per-instance lock is acquired
4. The affected node is:
   - Cordoned
   - Gracefully drained (tight timeout)
5. The instance is proactively terminated
6. Replacement capacity is launched immediately

## Replacement Strategy

- AZ-aware placement
- Spot-first
- Automatic on-demand fallback

## Safety Guarantees

- Drain failures abort termination
- Replacement does not interfere with normal scaling logic
- No double-handling due to per-instance locks

## Value

- Minimizes disruption during Spot termination
- Preserves cluster capacity
- Demonstrates real-world cloud-aware autoscaling design
