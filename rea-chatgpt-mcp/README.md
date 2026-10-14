# REA ChatGPT MCP bridge

An authenticated Streamable HTTP wrapper for the real [morluto/rea](https://github.com/morluto/rea) stdio MCP server. Uses Node 24, rea-agents 6.4.0, supergateway 4.1.0.

## Deploy

1. Use Docker with root directory `/rea-chatgpt-mcp` in Railway, Fly.io, or any persistent Node/Docker host.
2. Set `REA_CONNECTOR_KEY` to a random 32–128-character URL-safe secret (do not commit it). Railway provides `PORT` automatically; container defaults to 3000 otherwise.
3. Generate public HTTPS domain. Check `GET /health` returns 200 / ready.
4. In ChatGPT Developer Mode, add custom MCP connector, Streamable HTTP, auth None, URL `https://YOUR-HOST/mcp/YOUR-REA_CONNECTOR_KEY`.
5. Confirm MCP initialize, tools/list and safe target-independent tool calls. Refresh connector after upgrades.

## Security and capabilities

The protected URL is a bearer-like secret; share it only with trusted clients. Upstream Supergateway additionally requires a Bearer key and listens on localhost only. The public endpoint's secret lives in an environment variable, not source control.

This is a remote REA host: it only has access to files on its own container. It **cannot** read local Android/Termux/Ubuntu paths and does not install optional Hopper, Ghidra, IDA, Android, or other analysis providers. Those tools report unsupported/unavailable until configured on the execution host. Use a host with required analyzers or a secure file ingestion workflow for real targets.

Project source is separate from the REA upstream repository, without modifications to REA's original code. Fork location: `SonGohan231/rea/rea-chatgpt-mcp`.
