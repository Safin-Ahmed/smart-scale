import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";

import * as fs from "fs";

// VPC CIDR + my ip for SSH
const vpcCidr = "10.0.0.0/16";
const myIpCidr = "0.0.0.0/0";

// Prometheus Node Port
const prometheusNodePort = 30900;

// K3s cluster token
const clusterToken = pulumi.interpolate`k3s-cluster-token-123456789`;
const clusterTokenValue = pulumi.secret("k3s-cluster-token-123456789");

const clusterTokenParam = new aws.ssm.Parameter("k3s-cluster-token-param", {
  name: "/k3s-autoscaler/clusterToken",
  type: "SecureString",
  value: clusterTokenValue,
});

// AZs
const azs = aws.getAvailabilityZones({ state: "available" });

const vpc = new aws.ec2.Vpc("k3s-vpc", {
  cidrBlock: vpcCidr,
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: "k3s-vpc",
  },
});

const igw = new aws.ec2.InternetGateway("k3s-igw", {
  vpcId: vpc.id,
  tags: {
    Name: "k3s-igw",
  },
});

const publicRouteTable = new aws.ec2.RouteTable("k3s-public-rt", {
  vpcId: vpc.id,
  routes: [
    {
      cidrBlock: "0.0.0.0/0",
      gatewayId: igw.id,
    },
  ],
  tags: {
    Name: "k3s-public-rt",
  },
});

// Public Subnets (2 AZs)
const subnetA = new aws.ec2.Subnet("k3s-subnet-a", {
  vpcId: vpc.id,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: pulumi.output(azs).apply((azs) => azs.names[0]),
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "k3s-subnet-a",
  },
});

const subnetB = new aws.ec2.Subnet("k3s-subnet-b", {
  vpcId: vpc.id,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: pulumi.output(azs).apply((azs) => azs.names[1]),
  mapPublicIpOnLaunch: true,
  tags: {
    Name: "k3s-subnet-b",
  },
});

new aws.ec2.RouteTableAssociation("k3s-rt-assoc-a", {
  subnetId: subnetA.id,
  routeTableId: publicRouteTable.id,
});

new aws.ec2.RouteTableAssociation("k3s-rt-assoc-b", {
  subnetId: subnetB.id,
  routeTableId: publicRouteTable.id,
});

// Security Group
const sgMaster = new aws.ec2.SecurityGroup("sg_master", {
  vpcId: vpc.id,
  description: "K3s master SG",
  ingress: [
    { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: [myIpCidr] }, // SSH
  ],
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],
  tags: {
    Name: "k3s-master-sg",
  },
});

const sgWorker = new aws.ec2.SecurityGroup("sg_worker", {
  vpcId: vpc.id,
  description: "K3s worker SG",
  ingress: [
    { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: [myIpCidr] },
    { protocol: "tcp", fromPort: 30080, toPort: 30080, cidrBlocks: [myIpCidr] }, // SSH
    {
      protocol: "tcp",
      fromPort: prometheusNodePort,
      toPort: prometheusNodePort,
      cidrBlocks: [myIpCidr],
    }, // Accessible from outside
  ],
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],
  tags: {
    Name: "k3s-worker-sg",
  },
});

const sgLambda = new aws.ec2.SecurityGroup("sg_lambda", {
  vpcId: vpc.id,
  description: "Lambda SG",
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],
  tags: {
    Name: "k3s-lambda-sg",
  },
});

// SG to SG rules
new aws.ec2.SecurityGroupRule("master-allow-from-workers", {
  type: "ingress",
  securityGroupId: sgMaster.id,
  sourceSecurityGroupId: sgWorker.id,
  fromPort: 0,
  toPort: 0,
  protocol: "-1",
  description: "Allow all access from workers",
});

new aws.ec2.SecurityGroupRule("worker-allow-all-from-master", {
  type: "ingress",
  securityGroupId: sgWorker.id,
  sourceSecurityGroupId: sgMaster.id,
  fromPort: 0,
  toPort: 0,
  protocol: "-1",
  description: "Allow all traffic from master",
});

new aws.ec2.SecurityGroupRule("master-allow-prometheus-request-from-lambda", {
  type: "ingress",
  securityGroupId: sgMaster.id,
  sourceSecurityGroupId: sgLambda.id,
  fromPort: prometheusNodePort,
  toPort: prometheusNodePort,
  protocol: "tcp",
  description: "Allow Prometheus requests from Lambda",
});

new aws.ec2.SecurityGroupRule("workers-allow-prometheus-from-lambda", {
  type: "ingress",
  securityGroupId: sgWorker.id,
  sourceSecurityGroupId: sgLambda.id,
  fromPort: prometheusNodePort,
  toPort: prometheusNodePort,
  protocol: "tcp",
  description: "Allow Prometheus NodePort from Lambda",
});

new aws.ec2.SecurityGroupRule("lambda-sg-allow-https-self", {
  type: "ingress",
  securityGroupId: sgLambda.id,
  sourceSecurityGroupId: sgLambda.id,
  protocol: "tcp",
  fromPort: 443,
  toPort: 443,
  description: "Allow Lambda SG to reach Interface VPC Endpoints over HTTPS",
});

new aws.ec2.SecurityGroupRule("lambda-allow-vpc-https", {
  type: "ingress",
  securityGroupId: sgLambda.id,
  cidrBlocks: [vpcCidr], // Allow entire VPC to hit the endpoint
  protocol: "tcp",
  fromPort: 443,
  toPort: 443,
});

new aws.ec2.SecurityGroupRule("workers-allow-all-from-workers", {
  type: "ingress",
  securityGroupId: sgWorker.id,
  protocol: "-1",
  fromPort: 0,
  toPort: 0,
  sourceSecurityGroupId: sgWorker.id,
  description: "Allow worker to worker traffic (required for Flannel CNI)",
});

// Outputs
export const vpcId = vpc.id;
export const publicSubnetIds = [subnetA.id, subnetB.id];
export const masterSgId = sgMaster.id;
export const workerSgId = sgWorker.id;
export const lambdaSgId = sgLambda.id;
export const promNodePort = prometheusNodePort;

// PEM File Name For K3s Master EC2 Instance
const keyName = "k3s_master_key_v6";

const sshKey = pulumi.secret(
  fs.readFileSync(`${process.env.HOME}/.ssh/aws/${keyName}.pem`, "utf-8")
);

const masterRole = new aws.iam.Role("k3s-master-role", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ec2.amazonaws.com",
  }),
});

new aws.iam.RolePolicyAttachment("k3s-master-ssm", {
  role: masterRole.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
});

const masterInstanceProfile = new aws.iam.InstanceProfile(
  "k3s-master-instance-profile",
  {
    role: masterRole.name,
  }
);

const ubuntu2204 = aws.ec2.getAmi({
  owners: ["099720109477"], // Canonical
  mostRecent: true,
  filters: [
    {
      name: "name",
      values: ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"],
    },
    { name: "virtualization-type", values: ["hvm"] },
  ],
});

// Install K3s server
const userDataMaster = pulumi.interpolate`#!/bin/bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl

curl -sfL https://get.k3s.io | sh -s - server \\
  --token "${clusterToken}" \\
  --write-kubeconfig-mode 644 \\
  --disable traefik

sleep 5
k3s kubectl get nodes || true

MASTER_NODE="$(hostname)"
# Label master so monitoring can be pinned here
k3s kubectl label node "$MASTER_NODE" nodepool=monitoring --overwrite || true

# Taint master so normal workloads don't land here
k3s kubectl taint node "$MASTER_NODE" node-role.kubernetes.io/control-plane=true:NoSchedule --overwrite || true

snap install amazon-ssm-agent --classic || true
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent || true
`;

const masterInstance = new aws.ec2.Instance("k3s-master", {
  ami: pulumi.output(ubuntu2204).apply((ami) => ami.id),
  instanceType: "t3.medium",
  subnetId: subnetA.id,
  vpcSecurityGroupIds: [sgMaster.id],
  keyName: keyName,
  userData: userDataMaster,
  iamInstanceProfile: masterInstanceProfile.name,
  tags: {
    Name: "k3s-master",
    Role: "k3s-control-plane",
    Cluster: "k3s-autoscaler",
  },
});

const autoScalerRbac = new command.remote.Command(
  "autoscaler-rbac",
  {
    connection: {
      host: masterInstance.publicIp,
      user: "ubuntu",
      privateKey: sshKey,
    },
    create: `
set -euo pipefail
for i in $(seq 1 60); do
  if sudo k3s kubectl get nodes >/dev/null 2>&1; then break; fi
  sleep 2
done

cat <<'EOF' | sudo k3s kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: autoscaler
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: autoscaler
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get","list","patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get","list"]
  - apiGroups: ["policy"]
    resources: ["pods/eviction"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: autoscaler
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: autoscaler
subjects:
  - kind: ServiceAccount
    name: autoscaler
    namespace: kube-system
EOF
`,
  },
  { dependsOn: masterInstance }
);

// Mint token (pick duration; if cluster caps it, it'll shorten)
const autoscalerTokenCmd = new command.remote.Command(
  "autoscaler-token",
  {
    connection: {
      host: masterInstance.publicIp,
      user: "ubuntu",
      privateKey: sshKey,
    },
    create: `set -euo pipefail; sudo k3s kubectl -n kube-system create token autoscaler --duration=720h`,
  },
  { dependsOn: autoScalerRbac }
);

const apiTokenParam = new aws.ssm.Parameter("k3s-api-token-param", {
  name: "/k3s-autoscaler/k8sApiToken",
  type: "SecureString",
  value: pulumi.secret(autoscalerTokenCmd.stdout),
});

const workerUserData = pulumi.interpolate`#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl

export K3S_URL="https://${masterInstance.privateIp}:6443"
export K3S_TOKEN="${clusterToken}"

# Wait for the master to be ready. Try for ~2 minutes (24 * 5s).
for i in $(seq 1 24); do
  echo "[k3s-join] checking master ready (attempt $i)" >&2
  if curl -k --silent --fail https://${masterInstance.privateIp}:6443/readyz >/dev/null; then
    echo "[k3s-join] master ready" >&2
    break
  fi
  sleep 5
done

# If master wasn't detected, continue anyway and let k3s agent retry.
echo "[k3s-join] proceeding to install k3s agent" >&2
curl -sfL https://get.k3s.io | sh -s - agent
`;

const workerLaunchTemplate = new aws.ec2.LaunchTemplate("k3s-worker-lt", {
  imageId: pulumi.output(ubuntu2204).apply((a) => a.id),
  instanceType: "t3.small",
  keyName: keyName,
  vpcSecurityGroupIds: [sgWorker.id],
  iamInstanceProfile: { name: masterInstanceProfile.name },
  userData: workerUserData.apply((data) =>
    Buffer.from(data).toString("base64")
  ),
  tagSpecifications: [
    {
      resourceType: "instance",
      tags: { Name: "k3s-worker", Role: "k3s-worker" },
    },
  ],
});

const worker1 = new aws.ec2.Instance(
  "k3s-worker-1",
  {
    ami: pulumi.output(ubuntu2204).apply((a) => a.id),
    instanceType: "t3.medium",
    subnetId: subnetA.id,
    vpcSecurityGroupIds: [sgWorker.id],
    keyName: keyName,
    userData: workerUserData,
    iamInstanceProfile: masterInstanceProfile.name,
    tags: {
      Name: "k3s-worker-1",
      Role: "k3s-worker",
      Cluster: "k3s-autoscaler",
    },
  },
  { dependsOn: masterInstance }
);

const worker2 = new aws.ec2.Instance(
  "k3s-worker-2",
  {
    ami: pulumi.output(ubuntu2204).apply((a) => a.id),
    instanceType: "t3.medium",
    subnetId: subnetB.id,
    vpcSecurityGroupIds: [sgWorker.id],
    keyName: keyName,
    userData: workerUserData,
    iamInstanceProfile: masterInstanceProfile.name,
    tags: {
      Name: "k3s-worker-2",
      Role: "k3s-worker",
      Cluster: "k3s-autoscaler",
    },
  },
  { dependsOn: masterInstance }
);

const autoscalerTable = new aws.dynamodb.Table("k3s-autoscaler-state", {
  attributes: [{ name: "pk", type: "S" }],
  hashKey: "pk",
  billingMode: "PAY_PER_REQUEST",
  tags: { Name: "k3s-autoscaler-state" },
});

const autoscalerLogsTable = new aws.dynamodb.Table("k3s-autoscaler-logs", {
  attributes: [
    { name: "pk", type: "S" },
    { name: "sk", type: "S" },
  ],
  hashKey: "pk",
  rangeKey: "sk",
  billingMode: "PAY_PER_REQUEST",
  tags: { Name: "k3s-autoscaler-logs" },
});

const lambdaCode = new pulumi.asset.AssetArchive({
  ".": new pulumi.asset.FileArchive("../../autoscaler/dist"),
});

const autoscalerRole = new aws.iam.Role("k3s-autoscaler-role", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "lambda.amazonaws.com",
  }),
});

new aws.iam.RolePolicy("k3s-autoscaler-policy", {
  role: autoscalerRole.id,
  policy: pulumi
    .all([autoscalerTable.arn, autoscalerLogsTable.arn, masterRole.arn])
    .apply(([stateArn, logsArn, masterRoleArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
            ],
            Resource: stateArn,
          },
          {
            Effect: "Allow",
            Action: ["dynamodb:PutItem"],
            Resource: logsArn,
          },
          {
            Effect: "Allow",
            Action: [
              "ec2:DescribeInstances",
              "ec2:DescribeInstanceStatus",
              "ec2:TerminateInstances",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["ec2:RunInstances", "ec2:CreateTags"],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["iam:PassRole"],
            Resource: masterRoleArn,
          },
          {
            Effect: "Allow",
            Action: [
              "ssm:SendCommand",
              "ssm:GetCommandInvocation",
              "ssm:ListCommandInvocations",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["ssm:GetParameter", "ssm:GetParameters"],
            Resource: [apiTokenParam.arn, clusterTokenParam.arn],
          },
          {
            Effect: "Allow",
            Action: ["kms:Decrypt"],
            Resource: "*",
          },
        ],
      })
    ),
});

new aws.iam.RolePolicyAttachment("k3s-autoscaler-basic-exec", {
  role: autoscalerRole.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

new aws.iam.RolePolicyAttachment("k3s-autoscaler-vpc-access", {
  role: autoscalerRole.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaVPCAccessExecutionRole,
});

const autoscalerFn = new aws.lambda.Function("k3s-autoscaler", {
  runtime: "nodejs20.x",
  role: autoscalerRole.arn,
  handler: "handler.handler",
  code: lambdaCode,
  timeout: 600,
  memorySize: 256,
  environment: {
    variables: {
      STATE_TABLE: autoscalerTable.name,
      PROM_NODEPORT: "30900",
      WORKER_TAG_KEY: "Role",
      WORKER_TAG_VALUE: "k3s-worker",
      LOGS_TABLE: autoscalerLogsTable.name,
      CPU_UP: "0.70",
      CPU_DOWN: "0.30",
      PENDING_UP_SEC: "180",
      IDLE_DOWN_SEC: "600",
      COOLDOWN_UP_SEC: "300",
      DRAIN_TIMEOUT_SEC: "300",
      COOLDOWN_DOWN_SEC: "600",
      JOIN_TIMEOUT_SEC: "600",
      MIN_WORKERS: "2",
      MAX_WORKERS: "10",
      MASTER_TAG_KEY: "Role",
      MASTER_TAG_VALUE: "k3s-control-plane",
      CLUSTER_TAG_KEY: "Cluster",
      CLUSTER_TAG_VALUE: "k3s-autoscaler",
      WORKER_AMI_ID: pulumi.output(ubuntu2204).apply((a) => a.id),
      WORKER_INSTANCE_TYPE: "t3.medium",
      WORKER_SUBNET_IDS: pulumi.interpolate`${subnetA.id},${subnetB.id}`,
      WORKER_SG_ID: sgWorker.id,
      WORKER_KEY_NAME: keyName,
      K3S_CLUSTER_TOKEN_PARAM: clusterTokenParam.name,
      K8S_API_TOKEN_PARAM: apiTokenParam.name,
      WORKER_INSTANCE_PROFILE: masterInstanceProfile.name,
      PODS_PER_NODE: "10",
      MAX_BATCH_UP: "2",
    },
  },
  vpcConfig: {
    subnetIds: [subnetA.id, subnetB.id],
    securityGroupIds: [sgLambda.id],
  },
});

const scheduleRule = new aws.cloudwatch.EventRule("k3s-autoscaler-every-2m", {
  scheduleExpression: "rate(2 minutes)",
});

new aws.cloudwatch.EventTarget("k3s-autoscaler-target", {
  rule: scheduleRule.name,
  arn: autoscalerFn.arn,
});

new aws.lambda.Permission("k3s-autoscaler-allow-eventbridge", {
  action: "lambda:InvokeFunction",
  function: autoscalerFn.name,
  principal: "events.amazonaws.com",
  sourceArn: scheduleRule.arn,
});

const spotInterruptRule = new aws.cloudwatch.EventRule("spot-interruption", {
  eventPattern: JSON.stringify({
    source: ["aws.ec2"],
    "detail-type": ["EC2 Spot Instance Interruption Warning"],
  }),
});

new aws.cloudwatch.EventTarget("spot-interruption-target", {
  rule: spotInterruptRule.name,
  arn: autoscalerFn.arn,
});

new aws.lambda.Permission("allow-spot-interruption", {
  action: "lambda:InvokeFunction",
  function: autoscalerFn.name,
  principal: "events.amazonaws.com",
  sourceArn: spotInterruptRule.arn,
});

const spotRebalanceRule = new aws.cloudwatch.EventRule("spot-rebalance", {
  eventPattern: JSON.stringify({
    source: ["aws.ec2"],
    "detail-type": ["EC2 Instance Rebalance Recommendation"],
  }),
});

new aws.cloudwatch.EventTarget("spot-rebalance-target", {
  rule: spotRebalanceRule.name,
  arn: autoscalerFn.arn,
});

new aws.lambda.Permission("allow-spot-rebalance", {
  action: "lambda:InvokeFunction",
  function: autoscalerFn.name,
  principal: "events.amazonaws.com",
  sourceArn: spotRebalanceRule.arn,
});

const ddbEndpoint = new aws.ec2.VpcEndpoint("ddb-endpoint", {
  vpcId: vpc.id,
  serviceName: pulumi.interpolate`com.amazonaws.ap-southeast-1.dynamodb`,
  vpcEndpointType: "Gateway",
  routeTableIds: [publicRouteTable.id],
});

const ec2Endpoint = new aws.ec2.VpcEndpoint("ec2-endpoint", {
  vpcId: vpc.id,
  serviceName: pulumi.interpolate`com.amazonaws.ap-southeast-1.ec2`,
  vpcEndpointType: "Interface",
  subnetIds: [subnetA.id, subnetB.id],
  securityGroupIds: [sgLambda.id],
  privateDnsEnabled: true,
});

const ssmEndpoint = new aws.ec2.VpcEndpoint("ssm-endpoint", {
  vpcId: vpc.id,
  serviceName: pulumi.interpolate`com.amazonaws.ap-southeast-1.ssm`,
  vpcEndpointType: "Interface",
  subnetIds: [subnetA.id, subnetB.id],
  securityGroupIds: [sgLambda.id],
  privateDnsEnabled: true,
});

const ssmMessagesEndpoint = new aws.ec2.VpcEndpoint("ssm-messages-endpoint", {
  vpcId: vpc.id,
  serviceName: pulumi.interpolate`com.amazonaws.ap-southeast-1.ssmmessages`,
  vpcEndpointType: "Interface",
  subnetIds: [subnetA.id, subnetB.id],
  securityGroupIds: [sgLambda.id],
  privateDnsEnabled: true,
});

new aws.ec2.SecurityGroupRule("lambda-to-master-k3s-api", {
  type: "ingress",
  securityGroupId: sgMaster.id,
  sourceSecurityGroupId: sgLambda.id,
  protocol: "tcp",
  fromPort: 6443,
  toPort: 6443,
  description: "Allow Lambda to call K3s API directly",
});

export const masterPublicIp = masterInstance.publicIp;
export const masterPublicDns = masterInstance.publicDns;
export const sshToMaster = pulumi.interpolate`ssh -i ${keyName}.pem ubuntu@${masterInstance.publicIp}`;
export const worker1PublicIp = worker1.publicIp;
export const worker2PublicIp = worker2.publicIp;
export const sshToWorker1 = pulumi.interpolate`ssh -i ${keyName}.pem ubuntu@${worker1.publicIp}`;
export const sshToWorker2 = pulumi.interpolate`ssh -i ${keyName}.pem ubuntu@${worker2.publicIp}`;
