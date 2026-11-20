# Logto Helm chart (experimental)

This chart installs Logto, not PostgreSQL. Supply a dedicated, reachable PostgreSQL database and
an existing Kubernetes Secret in the release namespace containing its connection URL under `DB_URL`
(configurable with `database.secretKey`). Pass the Secret's **name**, not the URL, to Helm. Logto
needs permission to create PostgreSQL roles; check this with your managed database provider first.

## Install

For a fresh, empty database:

```sh
helm install logto ./helm/logto --namespace logto --wait --timeout 5m \
  --set database.existingSecret=logto-db \
  --set database.seedOnInstall=true
```

Leave `seedOnInstall` disabled for an existing database; make sure its schema matches the target
image before installing. The seed option runs one Helm hook Job before creating the Deployment,
not an init container that runs in every replica. The default Pod runs as a non-root user and has
a writable, Pod-local directory for the alteration scripts that Logto copies at startup.
Containers use a read-only root filesystem by default. `/tmp` (including the npm cache) and the
alteration-scripts directory are writable. If a custom image needs another writable path, adapt the
image or set `securityContext.readOnlyRootFilesystem=false`.

For a local check without Ingress:

```sh
kubectl -n logto port-forward svc/logto 3001:3001 3002:3002
curl -fsS http://localhost:3001/api/status
curl -fsS http://localhost:3001/oidc/.well-known/openid-configuration
```

Startup, readiness and liveness probes check the core service on port 3001. They do not monitor
the Admin Console listener on port 3002; monitor that separately if you expose it.

For Ingress, use a controller already installed in the cluster and provide the public origins.
The origins must use the matching host and `http` or `https`, with no explicit port, path, or
trailing slash:

```yaml
endpoint: https://login.example.com
adminEndpoint: https://admin.example.com
trustProxyHeader: true
ingress:
  enabled: true
  className: nginx
  host: login.example.com
  adminHost: admin.example.com
  tls:
    - secretName: logto-tls
      hosts: [login.example.com, admin.example.com]
```

Enable proxy header trust only if a trusted proxy sanitizes incoming forwarded headers and clients
cannot reach Logto directly. Omit `ingress.adminHost` if Admin Console should not be exposed through
this Ingress. That does not disable Admin Console on the internal Service. To disable it entirely,
leave `adminEndpoint` unset and set `ADMIN_DISABLE_LOCALHOST` to `"1"` via `extraEnv`. Do not override
`PORT` or `ADMIN_PORT` via `extraEnv`; the Service and probes use the default ports.

Use the same image and connector set on all replicas; bake custom connectors into a compatible
image rather than modifying individual Pods. This chart does not install connectors at runtime.

## Optional Redis cache

Redis is disabled by default (`redis.mode=disabled`). Logto still uses PostgreSQL as its database.
Redis is only a [shared cache](https://docs.logto.io/logto-oss/central-cache).

- **Bundled** (`redis.mode=bundled`): deploys one password-protected Redis Pod and a ClusterIP
  Service. Create a Secret in the release namespace containing `REDIS_PASSWORD` (or the key from
  `redis.passwordKey`), then set `redis.existingSecret` to its name. Use a long random password
  made only of letters, digits, `_`, and `-` so it can be used in the connection URL. This cache
  has no persistence, HA, or TLS. Restrict its network access to trusted workloads, and use an
  existing Redis service if you need TLS or HA. Restart both deployments after rotating the Secret.
- **External** (`redis.mode=external`): set `redis.existingSecret` to a Secret containing the
  Redis connection URL under `REDIS_URL` (or `redis.urlKey`). Use `rediss://` for TLS, and
  percent-encode special characters in the credentials. No Redis Pods are created by the chart.

Only the Logto application Pods receive the Redis configuration, not the database Jobs. If you
already set `REDIS_URL` through `extraEnv`, keep `redis.mode=disabled` or move that setting into
the Redis Secret configuration; do not use both.

## Optional Azure Blob Storage

For features such as avatar uploads, configure an existing Azure Storage account and blob container
as the [file storage provider](https://docs.logto.io/logto-oss/file-storage-provider#azure-storage).
The chart does not provision storage or manage its credentials. After the database is initialized,
run the following once from a trusted terminal. Keep `azure-storage.json` in a protected local
file, outside source control:

```json
{
  "provider": "AzureStorage",
  "connectionString": "<Azure Storage connection string>",
  "container": "logto"
}
```

```sh
kubectl -n logto exec -i deploy/logto -c logto -- \
  sh -ec 'config=$(cat); npm run cli -- db system set storageProvider "$config"' \
  < azure-storage.json
kubectl -n logto rollout restart deployment/logto
kubectl -n logto rollout status deployment/logto
```

Adjust the namespace and Deployment name for your release. The CLI stores the provider settings
in the shared Logto database; all replicas pick up the change after restarting. Avoid printing
the connection string or committing it to Helm values. If the feature needs clients to read the
uploaded files, configure a reachable storage endpoint or CDN (`publicUrl`); keep write access
limited to Logto. [Bring your UI](https://docs.logto.io/logto-oss/self-hosted-license#set-up-storage-for-bring-your-ui)
requires a self-hosted license and uses the separate `experienceBlobsProvider` setting.

## Optional Secret Vault

To enable [Secret Vault](https://docs.logto.io/secret-vault), create an existing Kubernetes Secret
in the release namespace with a `SECRET_VAULT_KEK` key. Its value should be a base64-encoded random
32-byte key (distinct from Kubernetes' own encoding of Secret data). Reference it in Helm values:

```yaml
extraEnv:
  - name: SECRET_VAULT_KEK
    valueFrom:
      secretKeyRef:
        name: logto-vault
        key: SECRET_VAULT_KEK
```

Keep the same key across replicas and upgrades, and back it up separately. Do not generate a new
key when rolling out new Pods: without the original key, Logto cannot decrypt existing vault data.

## Pod configuration

`extraEnv` applies only to Logto application Pods; use `database.extraEnv` for seed and migration
Jobs. Both accept Kubernetes `EnvVar` entries, including `valueFrom` for Secret references. Use
`database.existingSecret` and `database.secretKey` to configure `DB_URL` for both.

`nodeSelector`, `tolerations`, `affinity`, `podAnnotations` and `serviceAccountName` apply to both
Pod types. Provide an existing ServiceAccount in the release namespace if you set a name. The
chart disables automatic ServiceAccount token mounts. Workload identity injection by the platform
may still work independently of that setting.

Set `podDisruptionBudget.enabled=true` for a release with two or more replicas to limit voluntary
evictions (`podDisruptionBudget.maxUnavailable` defaults to `1`). It does not govern Deployment
rollouts or protect against involuntary outages.

## Upgrade

Read the [Logto upgrade guide](https://docs.logto.io/logto-oss/upgrading-oss-version), back up the
database, and pin the target image version. When the database is not migrated externally,
`database.migrateOnUpgrade=true` runs a single pre-upgrade Job from the target image and blocks
the rollout if it fails. Do not run overlapping upgrades or manage the same database with multiple
releases running schema hooks. A Helm rollback does **not** roll back the database. If a Job fails,
inspect its logs and database state before retrying. The Job does not retry failed Pods, but
rerunning Helm can create another Job. GitOps tools that only render Helm templates
should run seed and migrations separately unless they implement the required Helm hook lifecycle.

The hook migrates the database **while the old Pods are still running**. The default `RollingUpdate`
strategy also briefly runs both application versions together. Logto's upgrade guide describes
alterations as compatible with the **previous** version; verify the exact upgrade path, especially
if skipping releases. `strategy.type=Recreate` avoids overlap during the application rollout, but
does **not** stop old Pods before the pre-upgrade hook runs. If the migration is incompatible with
running old Pods (or compatibility is unknown), schedule downtime: suspend any reconciler or
autoscaler that would restore replicas, scale the old Deployment to zero and wait for its Pods to
exit, then run `helm upgrade` with the desired replica count.
