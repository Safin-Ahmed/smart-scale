# System Architecture

## Components

- VPC
- Public subnets (multi-AZ)
- EC2 (master + workers)
- Lambda autoscaler
- DynamoDB (state + logs)
- Prometheus
- EventBridge

## Data Flow

1. Lambda fetches metrics from Prometheus
2. Lambda reads/writes state to DynamoDB
3. Lambda launches / terminates EC2 instances
4. EventBridge triggers Lambda for Spot interruptions

## Network Architecture

- VPC CIDR
- Subnet-to-AZ mapping
- Security group rules
- VPC endpoints (EC2, SSM, DynamoDB)
