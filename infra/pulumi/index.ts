import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// VPC CIDR + my ip for SSH
const vpcCidr = "10.0.0.0/16";
const myIpCidr = "0.0.0.0/0";

// Prometheus Node Port
const prometheusNodePort = 30900;

// K3s cluster token
const clusterToken = pulumi.interpolate`k3s-cluster-token-123456789`;

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
const keyName = "k3s-master-key-4";

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
  },
});

const workerUserData = pulumi.interpolate`#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl

export K3S_URL="https://${masterInstance.privateIp}:6443"
export K3S_TOKEN="${clusterToken}"

for i in $(seq 1 120); do
  if curl -k --silent --fail https://${masterInstance.privateIp}:6443/readyz >/dev/null; then
    break
  fi
  sleep 5
done

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
    tags: {
      Name: "k3s-worker-2",
      Role: "k3s-worker",
      Cluster: "k3s-autoscaler",
    },
  },
  { dependsOn: masterInstance }
);

export const masterPublicIp = masterInstance.publicIp;
export const masterPublicDns = masterInstance.publicDns;
export const sshToMaster = pulumi.interpolate`ssh -i ${keyName}.pem ubuntu@${masterInstance.publicIp}`;
export const worker1PublicIp = worker1.publicIp;
export const worker2PublicIp = worker2.publicIp;
export const sshToWorker1 = pulumi.interpolate`ssh -i ${keyName}.pem ubuntu@${worker1.publicIp}`;
export const sshToWorker2 = pulumi.interpolate`ssh -i ${keyName}.pem ubuntu@${worker2.publicIp}`;
