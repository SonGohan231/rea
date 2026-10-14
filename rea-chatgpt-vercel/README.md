# REA MCP on Vercel

MCP bridge for [morluto/rea](https://github.com/morluto/rea), running the real `rea-agents@6.4.0` MCP process per JSON-RPC request, then returning a stateless Streamable HTTP JSON response.

## Configuration

Set `REA_CONNECTOR_KEY` as a Vercel encrypted environment variable (32–128 URL-safe characters). Deploy this folder using the Vercel Node.js 24 runtime. Use the public production domain and URL `https://<domain>/mcp/<secret>` for ChatGPT custom MCP connector (No auth; the URL path is its secret).

`GET /api/health` reports the adapter's configuration state only; verify an actual `initialize` and `tools/list` via the MCP endpoint before claiming REA works.

## Limitations

Vercel Functions have no guaranteed process persistence or durable local filesystem. Each request launches a new REA MCP subprocess. This allows tool discovery and independent tool calls, but tools requiring retained state, local user files, persistent Ghidra/IDA/Hopper instances or privileged executables may not work. This is not equivalent to a REA daemon running on your Ubuntu machine. Keep secrets out of Git and rotate the URL if exposed. 
