#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/logto-helm-smoke.XXXXXX")
export KUBECONFIG="$work_dir/kubeconfig"
cluster="logto-helm-$$"
namespace=logto-smoke
k=(kubectl --context "kind-$cluster" --namespace "$namespace")

cleanup() {
  local status=$?
  if (( status != 0 )) && [[ -s "$KUBECONFIG" ]]; then
    "${k[@]}" get pods,jobs,services -o wide || true
    "${k[@]}" get events --sort-by=.lastTimestamp || true
    "${k[@]}" logs deployment/postgres --tail=80 || true
    "${k[@]}" logs deployment/logto --tail=80 || true
    "${k[@]}" logs job/logto-seed --tail=80 || true
  fi
  kind delete cluster --name "$cluster" || true
  rm -f -- "$KUBECONFIG"
  rmdir -- "$work_dir" || true
}
trap cleanup EXIT

kind create cluster --name "$cluster" --kubeconfig "$KUBECONFIG" --wait 120s
"${k[@]}" create namespace "$namespace"
"${k[@]}" label namespace "$namespace" pod-security.kubernetes.io/enforce=restricted

password=$(openssl rand -hex 24)
"${k[@]}" create secret generic logto-db \
  --from-file=POSTGRES_PASSWORD=<(printf '%s' "$password") \
  --from-file=DB_URL=<(printf 'postgres://postgres:%s@postgres:5432/logto' "$password")
unset password

"${k[@]}" apply -f - <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 70
        runAsGroup: 70
        fsGroup: 70
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: postgres
          image: postgres:17-alpine
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
          env:
            - name: POSTGRES_DB
              value: logto
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: logto-db
                  key: POSTGRES_PASSWORD
          readinessProbe:
            exec:
              command: [pg_isready, -h, '127.0.0.1', -U, postgres, -d, logto]
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: data
          emptyDir: {}
YAML

"${k[@]}" rollout status deployment/postgres --timeout=2m
helm --kube-context "kind-$cluster" --namespace "$namespace" install logto "$repo_root/helm/logto" \
  --set database.existingSecret=logto-db --set database.seedOnInstall=true --wait --timeout 4m

"${k[@]}" exec -i deployment/logto -- node --input-type=module - <<'JS'
import assert from 'node:assert/strict';

const get = (port, path) =>
  fetch(`http://logto:${port}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
assert.equal((await get(3001, '/api/status')).status, 204);
const discovery = await get(3001, '/oidc/.well-known/openid-configuration');
assert.equal(discovery.status, 200);
const { issuer, jwks_uri } = await discovery.json();
assert.match(issuer, /\/oidc$/);
assert.equal(new URL(jwks_uri).origin, new URL(issuer).origin);

const admin = await get(3002, '/');
assert.equal(admin.status, 302);
assert.equal(admin.headers.get('location'), '/console/welcome');
console.log('Logto smoke passed: health, OIDC discovery, and admin welcome redirect');
JS
