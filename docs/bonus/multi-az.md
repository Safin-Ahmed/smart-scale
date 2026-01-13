# Bonus: Multi-AZ Awareness

## Problem

Launching instances into multiple subnets does not guarantee balanced placement.
Without explicit logic, clusters can silently drift into single-AZ dependency.

## Solution

This autoscaler implements **explicit Availability Zone awareness** for both
scale-up and scale-down operations.

## Scale-Up Behavior

1. Subnet → AZ mapping is discovered dynamically via EC2 APIs
2. Current worker distribution per AZ is calculated
3. New workers are launched into the **least populated AZ**
4. Nodes are launched one-by-one to maintain balance

## Scale-Down Behavior

1. Workers are grouped by AZ
2. Nodes are selected from the **most populated AZ**
3. When multiple AZs exist, draining an AZ to zero is avoided

## Value

- Improves fault tolerance
- Prevents silent AZ imbalance
- Mirrors production autoscaler behavior
- No static assumptions or hardcoded AZ logic

This behavior is fully dynamic and adapts to any number of AZs.
