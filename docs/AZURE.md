# Hosting on Azure

One small Ubuntu VM runs the daemon in Docker behind Caddy (automatic HTTPS). The canvas and the MCP endpoint share one host; the SQLite file lives in a Docker volume on the VM disk, so it survives restarts and updates.

## Deploy (once)
In [Azure Cloud Shell](https://shell.azure.com) (Bash), already logged in:

```bash
git clone https://github.com/lucacodastefano/knowledge-graph && cd knowledge-graph
deploy/azure/deploy.sh            # optional argument: resource name, default kg-luca
```

It prints two URLs after about 5 minutes:
- **Canvas**: `https://<name>.swedencentral.cloudapp.azure.com/?token=<secret>` (sets a login cookie, then the token disappears from the address bar).
- **Claude connector**: `https://<name>.swedencentral.cloudapp.azure.com/t/<secret>/mcp`. In Claude (Settings > Connectors > Add custom connector) paste it with no other auth. The secret in the URL is the only protection: treat the URL like a password.

## Update, cost, data
- Update to the latest `main`: `deploy/azure/update.sh`.
- Cost: The script picks the first available small size (B1s, B2ats_v2, B1ms...); B1s and B2ats_v2 are free for 12 months on a new Azure account, about EUR 8-10/month afterwards. If the region has none, run `LOCATION=northeurope deploy/azure/deploy.sh`. Set a budget alert in the portal. Delete everything with `az group delete -n rg-<name>`.
- Backup: `ssh kg@<fqdn>` then `sudo docker compose -f /opt/kg/deploy/azure/docker-compose.yml exec app node -e "new (require('node:sqlite').DatabaseSync)('/data/graph.db').exec(\"VACUUM INTO '/data/backup.db'\")"`.
- Env vars of the daemon: `KG_HOST` (default `127.0.0.1`) and `KG_TOKEN`. A non-local host without a token refuses to start. Without `KG_TOKEN` nothing changes for local use.
