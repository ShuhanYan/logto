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

For a local check without Ingress:

```sh
kubectl -n logto port-forward svc/logto 3001:3001 3002:3002
curl -fsS http://localhost:3001/api/status
curl -fsS http://localhost:3001/oidc/.well-known/openid-configuration
```

For Ingress, use a controller already installed in the cluster and provide the public origins:

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

## Upgrade

Read the [Logto upgrade guide](https://docs.logto.io/logto-oss/upgrading-oss-version), back up the
database, and pin the target image version. When the database is not migrated externally,
`database.migrateOnUpgrade=true` runs a single pre-upgrade Job from the target image and blocks
the rollout if it fails. Do not run overlapping upgrades or manage the same database with multiple
releases running schema hooks. A Helm rollback does **not** roll back the database. If a Job fails,
inspect its logs and database state before retrying. GitOps tools that only render Helm templates
should run seed and migrations separately unless they implement the required Helm hook lifecycle.
