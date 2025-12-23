# Tunneling with master node
ssh -i k3s-master-key.pem -N -L 6443:127.0.0.1:6443 ubuntu@<MASTER_PUBLIC_IP>

# Copy Kubeconfig from master node
scp -i k3s-master-key.pem ubuntu@<MASTER_PUBLIC_IP>:/etc/rancher/k3s/k3s.yaml ./k3s.yaml

# Run kubectl from your host machine
export KUBECONFIG=$PWD/k3s.yaml
kubectl config view --minify | grep server
kubectl get nodes -o wide

# Create namespaces
kubectl create namespace ecommerce
kubectl create namespace monitoring

# Apply kubernetes deployment
kubectl apply -f services/checkout/k8s/checkout.yaml

# Install Helm
brew install helm

# Add Prometheus to k3s
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install mon prometheus-community/kube-prometheus-stack -n monitoring

helm upgrade --install mon prometheus-community/kube-prometheus-stack \
  -n monitoring \
  -f infra/k8s/monitoring/values.yaml

kubectl -n monitoring get pods

kubectl -n monitoring get prometheus

# Find the prometheus service
kubectl -n monitoring get svc | grep -i prometheus
kubectl -n monitoring get svc mon-kube-prometheus-stack-prometheus

# Patch the service to expose nodeport
kubectl -n monitoring patch svc mon-kube-prometheus-stack-prometheus -p '{
  "spec": {
    "type": "NodePort",
    "ports": [{
      "name":"http-web",
      "port":9090,
      "targetPort":9090,
      "nodePort":30900
    }]
  }
}'