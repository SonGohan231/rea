# REA MCP — cloud-only on Vercel

Live project: https://rea-chatgpt-vercel.vercel.app

## Architecture

ChatGPT -> Vercel HTTPS MCP -> real REA 6.4.0 subprocess per request.
Private files: Vercel Blob store `rea-analysis-files` in iad1. No Ubuntu or Termux.

Set `REA_CONNECTOR_KEY` (min 32 URL-safe characters) as an encrypted Vercel env variable. Vercel Blob automatically injects `BLOB_READ_WRITE_TOKEN` from the connected private store. Never commit either secret.

- MCP URL: `https://rea-chatgpt-vercel.vercel.app/mcp/<REA_CONNECTOR_KEY>`
- Secure file upload interface: `https://rea-chatgpt-vercel.vercel.app/upload/<REA_CONNECTOR_KEY>`
- `/api/health`: checks adapter configuration only.
- File API: authenticated `GET /files/<key>`, `PUT /files/<key>` with `x-file-name: <URL-encoded-name>` and binary body, `DELETE /files/<key>?id=<file_id>`, `GET /download/<key>?id=<file_id>`.

Cloud MCP tools (added to REA's native tools): `cloud_upload_base64` (<=512 KiB), `cloud_list_files`, `cloud_inspect_file`, `cloud_extract_strings`, `cloud_read_text`, `cloud_delete_file`.

Private blob names are restricted to `rea/<uuid>/<safe_filename>`. Web uploads up to 4 MiB because Vercel Functions have a 4.5-MB request body limit. Uploads and downloaded data are not executed; inspection only reads file signatures, hashes and strings.

## Important limitations

A successful MCP handshake and tool list does **not** imply the 170 native REA analyzer tools can operate on a stored file. REA tools depending on Ghidra, IDA, Hopper, local platform programs, persistent process state or persistent filesystem still require a dedicated cloud analyzer worker and explicit file staging. This release adds useful lightweight cloud analysis and durable private storage, **not** fully featured native disassembly. The configured Vercel environment is stateless.

For tests, verify: `initialize`, `tools/list` includes `cloud_*`, a private file `PUT` or `cloud_upload_base64`, `cloud_inspect_file`, `cloud_extract_strings`, then delete the test file. Never expose the secret URL to logs, screenshots or repositories. Rotate it if it leaks.
