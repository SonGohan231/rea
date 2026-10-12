import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('REA HTTP MCP bridge forwards real child responses and enforces permissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rea-bridge-test-'));
  const entry = join(dir, 'fake-rea.mjs');
  const secret = join(dir, 'bearer');
  const token = 'test-' + 'a'.repeat(64);
  writeFileSync(secret, token);
  const fakeSource = [
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', data => {",
    "  buffer += data;",
    "  let index;",
    "  while ((index = buffer.indexOf('\\n')) >= 0) {",
    "    const line = buffer.slice(0, index);",
    "    buffer = buffer.slice(index + 1);",
    "    if (!line) continue;",
    "    const r = JSON.parse(line);",
    "    if (r.id === undefined) continue;",
    "    let result;",
    "    if (r.method === 'initialize') result = {protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'mock-rea', version: '1.0.0'}};",
    "    else if (r.method === 'tools/list') result = {tools: [{name: 'rea_hello', inputSchema: {type: 'object'}}, {name: 'rea_private', inputSchema: {type: 'object'}}]};",
    "    else if (r.method === 'tools/call') result = {content: [{type: 'text', text: 'actual child ' + r.params.name}]};",
    "    else result = {};",
    "    process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: r.id, result}) + '\\n');",
    "  }",
    "});",
  ].join('\n');
  writeFileSync(entry, fakeSource);
  const port = await freePort();
  const bridge = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: {...process.env, REA_BRIDGE_PORT: String(port), REA_BRIDGE_ENTRY: entry,
      REA_BRIDGE_TOKEN_FILE: secret, REA_BRIDGE_ALLOWED_TOOLS: 'rea_hello'},
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    const url = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const health = await fetch(url + '/health');
        ready = health.status === 200;
        if (ready) break;
      } catch {}
      await pause(100);
    }
    assert.ok(ready, 'Server did not become healthy');
    const request = (data, session, addAuth = true) =>
      fetch(url + '/mcp', {method: 'POST', headers: {
        'content-type': 'application/json', 'accept': 'application/json, text/event-stream',
        ...(addAuth ? {authorization: 'Bearer ' + token} : {}),
        ...(session ? {'mcp-session-id': session} : {}),
      }, body: JSON.stringify(data)});
    const init = {jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version: '1.0'}}};
    assert.equal((await request(init, null, false)).status, 401);
    const start = await request(init);
    assert.equal(start.status, 200);
    const sid = start.headers.get('mcp-session-id');
    assert.ok(sid);
    assert.equal((await start.json()).result.serverInfo.name, 'mock-rea');
    const listed = await request({jsonrpc: '2.0', id: 2, method: 'tools/list'}, sid);
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).result.tools.map(t => t.name), ['rea_hello']);
    const blocked = await request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'rea_private'}}, sid);
    assert.equal(blocked.status, 403);
    const called = await request({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'rea_hello', arguments: {}}}, sid);
    assert.equal((await called.json()).result.content[0].text, 'actual child rea_hello');
    assert.equal((await request({jsonrpc: '2.0', method: 'notifications/initialized'}, sid)).status, 202);
    const end = await fetch(url + '/mcp', {method: 'DELETE',
      headers: {authorization: 'Bearer ' + token, 'mcp-session-id': sid}});
    assert.equal(end.status, 204);
    assert.equal((await request({jsonrpc: '2.0', id: 5, method: 'tools/list'}, sid)).status, 404);
  } finally {
    bridge.kill();
    rmSync(dir, {recursive: true, force: true});
  }
});