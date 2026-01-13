# EC2 User Data – Component Specification

This document describes the bootstrap scripts (user-data) used to initialize the K3s control plane (master) and worker nodes.

These scripts are intentionally minimal and deterministic so that newly launched instances can join the cluster automatically with no manual steps.

<br />

## Master Node User Data

**Responsibilities**

The master node user-data performs the following tasks:

1. Install K3s server (control plane)
2. Configure cluster token and kubeconfig permissions
3. Disable default Traefik (optional system choice)
4. Label the master node so monitoring can be pinned here
5. Taint the master node to prevent application workloads from scheduling on it
6. Enable Amazon SSM agent for remote execution/debugging

---

### Key Implementation Notes

- **Cluster token** is used for node join authentication.
- The master is treated as a **stable node** and is never deprovisioned.
- Monitoring stack is pinned to master using:
  - `nodeSelector` label (`nodepool=monitoring`)
  - Taint tolerance (for control-plane taint)

---

### Example Master User Data (Representative)

```bash
#!/bin/bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl

curl -sfL https://get.k3s.io | sh -s - server \
  --token "<CLUSTER_TOKEN>" \
  --write-kubeconfig-mode 644 \
  --disable traefik

sleep 5
k3s kubectl get nodes || true

MASTER_NODE="$(hostname)"

# Label master so monitoring can be pinned here
k3s kubectl label node "$MASTER_NODE" nodepool=monitoring --overwrite || true

# Taint master so normal workloads don't schedule here
k3s kubectl taint node "$MASTER_NODE" node-role.kubernetes.io/control-plane=true:NoSchedule --overwrite || true

# Enable SSM
snap install amazon-ssm-agent --classic || true
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent || true
```

## Worker Node User Data

### Responsibilities

Worker node user-data performs the following tasks:

1. Install dependencies (curl)

2. Configure K3s agent join settings:

   - K3S_URL pointing to the master API server

   - K3S_TOKEN for authentication

3. Wait for master readiness (/readyz) briefly before attempting install

4. Install K3s agent and let the agent handle retries if master is not ready

<br />

## Key Implementation Notes

- Workers can be launched as Spot or On-Demand; user-data is identical.

- A readiness loop improves join reliability when master is still booting.

- If readiness check fails, the script continues anyway and K3s agent will retry.

<br />

## Example Worker User Data (Representative)

```bash

#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl

export K3S_URL="https://<MASTER_PRIVATE_IP>:6443"
export K3S_TOKEN="<CLUSTER_TOKEN>"

# Wait for the master to be ready (~2 minutes)
for i in $(seq 1 24); do
  echo "[k3s-join] checking master ready (attempt $i)" >&2
  if curl -k --silent --fail https://<MASTER_PRIVATE_IP>:6443/readyz >/dev/null; then
    echo "[k3s-join] master ready" >&2
    break
  fi
  sleep 5
done

echo "[k3s-join] proceeding to install k3s agent" >&2
curl -sfL https://get.k3s.io | sh -s - agent

```

<br />

## Security & Secrets

- The cluster join token is treated as a secret and stored in AWS SSM Parameter Store.

- The autoscaler Lambda retrieves the token when launching workers.

- The Kubernetes API token (service account token) is also stored in SSM and used only by Lambda.
