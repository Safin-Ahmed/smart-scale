import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeSubnetsCommand,
  RunInstancesCommand,
  _InstanceType,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({});

export async function listRunningWorkers(
  tagKey: string,
  tagValue: string
): Promise<
  {
    instanceId: string;
    launchTime: Date;
    privateIp: string;
    availabilityZone: string;
    subnetId: string;
  }[]
> {
  const out = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${tagKey}`, Values: [tagValue] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    })
  );

  const ips: {
    instanceId: string;
    launchTime: Date;
    privateIp: string;
    availabilityZone: string;
    subnetId: string;
  }[] = [];

  for (const r of out.Reservations ?? []) {
    for (const i of r.Instances ?? []) {
      if (i.PrivateIpAddress)
        ips.push({
          instanceId: i.InstanceId!,
          launchTime: i.LaunchTime!,
          privateIp: i.PrivateIpAddress,
          availabilityZone: i.Placement?.AvailabilityZone!,
          subnetId: i.SubnetId!,
        });
    }
  }

  return ips;
}

export async function pickWorkerPrivateIp(
  tagKey: string,
  tagValue: string
): Promise<string> {
  const ips = await listRunningWorkers(tagKey, tagValue);

  if (ips.length === 0) throw new Error("No running worker instances found");

  return ips[0].privateIp;
}

function workerUserData(masterIp: string, token: string) {
  return `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl

export K3S_URL="https://${masterIp}:6443"
export K3S_TOKEN="${token}"

# Wait for the master to be ready. Try for ~2 minutes (24 * 5s).
for i in $(seq 1 24); do
  echo "[k3s-join] checking master ready (attempt $i)" >&2
  if curl -k --silent --fail https://${masterIp}:6443/readyz >/dev/null; then
    echo "[k3s-join] master ready" >&2
    break
  fi
  sleep 5
done

# If master wasn't detected, continue anyway and let k3s agent retry.
echo "[k3s-join] proceeding to install k3s agent" >&2
curl -sfL https://get.k3s.io | sh -s - agent
`;
}

export async function launchWorkers(
  masterIp: string,
  count: number,
  token: string,
  opts?: { subnetId?: string }
) {
  const amiId = process.env.WORKER_AMI_ID!;
  const instanceType = process.env.WORKER_INSTANCE_TYPE ?? "t3.medium";
  const subnetIds = (process.env.WORKER_SUBNET_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sgId = process.env.WORKER_SG_ID!;
  const keyName = process.env.WORKER_KEY_NAME!;
  const profileName = process.env.WORKER_INSTANCE_PROFILE!;
  const clusterVal = process.env.CLUSTER_TAG_VALUE ?? "k3s-autoscaler";

  if (subnetIds.length === 0) throw new Error("WORKER_SUBNET_IDS is empty");

  const userDataB64 = Buffer.from(
    workerUserData(masterIp, token),
    "utf8"
  ).toString("base64");

  const launched: string[] = [];

  for (let i = 0; i < count; i++) {
    const subnetId = opts?.subnetId ?? subnetIds[i % subnetIds.length];

    const res = await ec2.send(
      new RunInstancesCommand({
        ImageId: amiId,
        InstanceType: _InstanceType.t3_medium,
        MinCount: 1,
        MaxCount: 1,
        SubnetId: subnetId,
        SecurityGroupIds: [sgId],
        KeyName: keyName,
        UserData: userDataB64,
        IamInstanceProfile: { Name: profileName },
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              { Key: "Name", Value: "k3s-worker" },
              { Key: "Role", Value: "k3s-worker" },
              { Key: "Cluster", Value: clusterVal },
            ],
          },
        ],
      })
    );

    const id = res.Instances?.[0]?.InstanceId;
    if (id) launched.push(id);
  }

  return launched;
}

export async function findMasterPrivateIp(): Promise<string> {
  const masterTagKey = process.env.MASTER_TAG_KEY!;
  const masterTagValue = process.env.MASTER_TAG_VALUE!;
  const clusterTagKey = process.env.CLUSTER_TAG_KEY!;
  const clusterTagValue = process.env.CLUSTER_TAG_VALUE!;

  const res = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${masterTagKey}`, Values: [masterTagValue] },
        { Name: `tag:${clusterTagKey}`, Values: [clusterTagValue] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    })
  );

  const instances = res.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
  const withIp = instances.filter((i) => i.PrivateIpAddress);

  if (withIp.length === 0) throw new Error("Master not found by tags");

  // pick newest running master
  withIp.sort(
    (a, b) =>
      new Date(b.LaunchTime ?? 0).getTime() -
      new Date(a.LaunchTime ?? 0).getTime()
  );

  return withIp[0].PrivateIpAddress!;
}

// Find master INSTANCE ID (needed for SSM)
export async function findMasterInstanceId(): Promise<string> {
  const masterTagKey = process.env.MASTER_TAG_KEY!;
  const masterTagValue = process.env.MASTER_TAG_VALUE!;
  const clusterTagKey = process.env.CLUSTER_TAG_KEY!;
  const clusterTagValue = process.env.CLUSTER_TAG_VALUE!;

  const res = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${masterTagKey}`, Values: [masterTagValue] },
        { Name: `tag:${clusterTagKey}`, Values: [clusterTagValue] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    })
  );

  const instances = res.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
  if (instances.length === 0)
    throw new Error("Master instance not found by tags");

  instances.sort(
    (a, b) =>
      new Date(b.LaunchTime ?? 0).getTime() -
      new Date(a.LaunchTime ?? 0).getTime()
  );

  const id = instances[0].InstanceId;
  if (!id) throw new Error("Master missing InstanceId");
  return id;
}

// Get private IPs for instance IDs (needed for Ready verification)
export async function getPrivateIpsForInstanceIds(instanceIds: string[]) {
  const res = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: instanceIds })
  );

  const instances = res.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
  const out: { id: string; ip: string }[] = [];

  for (const i of instances) {
    if (i.InstanceId && i.PrivateIpAddress)
      out.push({ id: i.InstanceId, ip: i.PrivateIpAddress });
  }

  return out;
}

// Terminate EC2 Instances
export async function terminateInstances(instanceIds: string[]): Promise<void> {
  await ec2.send(
    new TerminateInstancesCommand({
      InstanceIds: instanceIds,
    })
  );
}

export async function describeSubnetsAz(
  subnetIds: string[]
): Promise<{ subnetId: string; availabilityZone: string }[]> {
  if (subnetIds.length === 0) return [];

  const res = await ec2.send(
    new DescribeSubnetsCommand({
      SubnetIds: subnetIds,
    })
  );

  return (res.Subnets ?? [])
    .filter((s) => s.SubnetId && s.AvailabilityZone)
    .map((s) => ({
      subnetId: s.SubnetId!,
      availabilityZone: s.AvailabilityZone!,
    }));
}
