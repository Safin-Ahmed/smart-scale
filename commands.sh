# CLI COMMAND FOR AWS PEM KEY
aws ec2 create-key-pair \
    --key-name k3s_master_key_v5 \
    --key-type rsa \
    --query 'KeyMaterial' \
    --output text > k3s_master_key_v5.pem

chmod 400 k3s_master_key_v5.pem


# Tunneling with master node
ssh -i k3s_master_key_v5.pem -N -L 6443:127.0.0.1:6443 ubuntu@47.128.71.206

# Copy Kubeconfig from master node
scp -i k3s_master_key_v5.pem ubuntu@47.128.71.206:/etc/rancher/k3s/k3s.yaml ./k3s.yaml

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
  -f infra/k8s/values.yaml

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


# Scale replicas to increase pending pod count to trigger scaling
kubectl -n ecommerce scale deploy checkout --replicas=20

# Deploy pending-test to quickly test pending pods
kubectl apply -f ./services/checkout/k8s/pending-test.yaml
kubectl -n ecommerce get pods -l app=pending-test

# Remove the test deployment
kubectl -n ecommerce delete deploy pending-test

# Invoke Lambda Manually
aws lambda invoke \
--region ap-southeast-1 \
--function-name k3s-autoscaler-25b797a \
/tmp/out.json && cat /tmp/out.json

aws dynamodb describe-table \
  --region ap-southeast-1 \
  --table-name k3s-autoscaler-logs-ae2acee

# Command to see dynamo db logs (latest first)
aws dynamodb query \
  --region ap-southeast-1 \
  --table-name k3s-autoscaler-logs-ae2acee \
  --key-condition-expression "pk = :p" \
  --expression-attribute-values '{":p":{"S":"cluster"}}' \
  --no-scan-index-forward \
  --limit 20


# Command to remove lock from dynamo db 
aws dynamodb update-item \
  --region ap-southeast-1 \
  --table-name k3s-autoscaler-state-26780cb \
  --key '{"pk":{"S":"cluster"}}' \
  --update-expression "SET scalingInProgress=:f, lockOwner=:e, lockUntilEpoch=:z" \
  --expression-attribute-values '{":f":{"BOOL":false},":e":{"S":""},":z":{"N":"0"}}'

curl -s "http://47.128.252.179:30900/api/v1/query?query=kube_state_metrics_build_info" | head -c 400
