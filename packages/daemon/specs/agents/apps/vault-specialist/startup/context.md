# Startup Context: Vault Managed App

## Environment

This rig runs HashiCorp Vault in dev mode as a managed environment service. Vault boots before you launch — by the time you receive this context, Vault should already be healthy.

## Access

- **Address:** `http://127.0.0.1:8200`
- **Dev root token:** `openrig-dev-token`
- **UI:** `http://127.0.0.1:8200/ui`
- **API:** `http://127.0.0.1:8200/v1`

## Checking Status

Use OpenRig env surfaces first:

```bash
rig env status <rig-name>
```

For direct Vault health checks:

```bash
curl -s http://127.0.0.1:8200/v1/sys/health | jq .
```

Or via the Vault CLI if available:

```bash
vault status -address=http://127.0.0.1:8200
```

## Your Role

You are the Vault specialist. Other agents in larger topologies may delegate Vault-domain work to you. When they do, use your domain knowledge to perform the requested operations and report results clearly.
