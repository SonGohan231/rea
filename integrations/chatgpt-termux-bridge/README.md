# REA to ChatGPT MCP: Termux bridge (experimental)

This integration adapts the existing REA stdio MCP to stateful HTTP JSON-RPC.
It does not replace REA, implement OAuth or register a ChatGPT plugin.

## Prerequisites
- Clone SonGohan231/rea with its exact audited SHA; use Node from .nvmrc.
- REA's published npm cache on the tested phone was missing dist/mcp/main.js.
- Build the real runtime before starting any HTTP bridge.
- Do not change or restart the working TelefonMCP2 server.
- Never expose a command-capable REA process to unauthenticated Internet clients.

## Installation in a separate Termux directory

    git clone --depth 1 https://github.com/SonGohan231/rea.git ~/rea-mcp-source
    cd ~/rea-mcp-source
    npm ci
    npm run build:termux
    test -f dist/mcp/main.js
    node --test integrations/chatgpt-termux-bridge/server.test.mjs

Create the token outside the repository:

    umask 077
    openssl rand -hex 32 > ~/.rea-mcp-bridge-token

Start the bridge in its own Termux process:

    cd ~/rea-mcp-source
    export REA_BRIDGE_TOKEN_FILE="$HOME/.rea-mcp-bridge-token"
    export REA_BRIDGE_ALLOWED_TOOLS="get_server_info"
    node integrations/chatgpt-termux-bridge/server.mjs

Change the example tool name to the actual allowed tools after inspecting REA's
live catalog. Defaults: port 3301, loopback 127.0.0.1, deny all tools until
explicitly listed. Wildcard allowlists are prohibited.

## Testing

GET /health is an unprivileged health probe; POST /mcp requires
Authorization: Bearer (contents of the token file).
Example initialization:

    TOKEN="$(cat ~/.rea-mcp-bridge-token)"
    curl -i -X POST http://127.0.0.1:3301/mcp -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"rea-probe","version":"1.0"}}}'

Use the returned Mcp-Session-Id for notifications/initialized, tools/list
and tools/call. Unlisted tools must fail. Verify real Evidence with a harmless
test fixture, not private phone directories.

## Connecting to ChatGPT

Do not expose port 3301 directly through a public ngrok URL. The implemented
bearer check is adequate for private tests but not an OAuth flow for custom
ChatGPT app login. Deploy a trusted OAuth 2.1 resource proxy or supported
secure MCP tunnel in front of the loopback bridge. That layer must:
1. Verify identity and permissions on each request.
2. Inject the private bearer only for trusted proxy-to-bridge traffic.
3. Publish required OAuth resource metadata and scope enforcement.
4. Prevent access to arbitrary Termux files, secrets, and optional providers.
5. Provide a stable HTTPS /mcp endpoint separate from TelefonMCP2.
6. Pass initialize, tools/list, tools/call and unauthorized-call checks.
7. Register and install the app in ChatGPT, then test from a conversation.

Do not put a bearer token in a plugin manifest, URL, logs or Git commits.

## Implementation boundaries

- Each HTTP MCP session has its own REA stdio child and Evidence lifecycle.
- Requests and canonical result objects are forwarded without reinterpretation.
- Four sessions max, 30-minute idle expiration, 90-second operation deadline.
- HTTP JSON mode; no server-initiated SSE, progress relay, OAuth or binary streams.
- The included test uses a fake stdio backend; it proves only the transport
  contract, not live REA reverse engineering or ChatGPT app installation.
- Never claim E2E pass without a real REA child, authenticated HTTPS access
  and a successful tool call from ChatGPT.
