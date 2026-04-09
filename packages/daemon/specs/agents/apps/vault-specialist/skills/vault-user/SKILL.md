# Vault User

You have access to a HashiCorp Vault instance managed by this rig's environment.

## Connection

- **Address:** `http://127.0.0.1:8200`
- **Token:** `openrig-dev-token`
- **Auth header:** `X-Vault-Token: openrig-dev-token`

Always set the token before making API calls. For curl, use `-H "X-Vault-Token: openrig-dev-token"`.

## Health Check

```bash
curl -s http://127.0.0.1:8200/v1/sys/health | jq .
```

A healthy response has `"initialized": true` and `"sealed": false`.

## Secret Operations

### Write a secret

```bash
curl -s -X POST http://127.0.0.1:8200/v1/secret/data/<path> \
  -H "X-Vault-Token: openrig-dev-token" \
  -d '{"data": {"key": "value"}}' | jq .
```

### Read a secret

```bash
curl -s http://127.0.0.1:8200/v1/secret/data/<path> \
  -H "X-Vault-Token: openrig-dev-token" | jq .
```

The secret value is in `.data.data`.

### List secrets

```bash
curl -s -X LIST http://127.0.0.1:8200/v1/secret/metadata/ \
  -H "X-Vault-Token: openrig-dev-token" | jq .
```

List a subdirectory by appending the path: `.../secret/metadata/<prefix>/`.

### Delete a secret

```bash
curl -s -X DELETE http://127.0.0.1:8200/v1/secret/data/<path> \
  -H "X-Vault-Token: openrig-dev-token"
```

## Explaining Secrets

When asked to explain the current secret structure, list all paths and summarize what each contains. Use the list endpoint recursively if needed.

## Important Notes

- This is Vault dev mode — all data is in-memory and lost on restart
- The KV secrets engine is mounted at `secret/` by default in dev mode
- Use the `rig env status` command to verify Vault health through OpenRig before direct probing
