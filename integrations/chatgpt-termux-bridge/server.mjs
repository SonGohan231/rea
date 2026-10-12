#!/usr/bin/env node
/**
 * REA stdio MCP -> private Streamable HTTP MCP bridge.
 * Keep behind an authenticated reverse proxy or tunnel; bind to loopback only.
 * The bridge does not implement an OAuth authorization server.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = process.env.REA_BRIDGE_ENTRY ?? path.resolve(here, '../../scripts/rea.mjs');
const port = Number(process.env.REA_BRIDGE_PORT ?? 3301);
const tokenFile = process.env.REA_BRIDGE_TOKEN_FILE;
if (!tokenFile) throw new Error('REA_BRIDGE_TOKEN_FILE is required; store a secret outside Git');
const token = readFileSync(tokenFile, 'utf8').trim();
if (token.length < 32) throw new Error('REA bridge bearer token must contain at least 32 characters');
const allowed = new Set((process.env.REA_BRIDGE_ALLOWED_TOOLS ?? '').split(',').map(v => v.trim()).filter(Boolean));
if (allowed.has('*')) throw new Error('Wildcard tools are forbidden; use an explicit allowlist');
const sessions = new Map();
const MAX_SESSIONS = 4;
const IDLE_MS = 30 * 60 * 1000;
const DEADLINE_MS = 90 * 1000;
const MAX_POST = 1024 * 1024;
const MAX_FRAME = 12 * 1024 * 1024;

const jsonError = (id, code, message) => ({jsonrpc: '2.0', id: id ?? null, error: {code, message}});
const idKey = id => typeof id + ':' + String(id);
const send = (res, status, data, extra = {}) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra,
  });
  res.end(JSON.stringify(data));
};
const authorized = req => {
  const value = req.headers.authorization ?? '';
  if (!value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
function closeSession(s) {
  if (sessions.get(s.id) === s) sessions.delete(s.id);
  for (const [key, waiter] of s.pending) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('REA MCP child terminated'));
    s.pending.delete(key);
  }
  if (!s.child.killed) s.child.kill();
}
function startSession() {
  const childEnv = {...process.env};
  delete childEnv.REA_BRIDGE_TOKEN_FILE;
  delete childEnv.REA_BRIDGE_ALLOWED_TOOLS;
  const child = spawn(process.execPath, [entry, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(entry), env: childEnv,
  });
  const s = {id: randomUUID(), child, pending: new Map(), buffer: '', lastAccess: Date.now(), stderr: ''};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    s.buffer += data;
    if (Buffer.byteLength(s.buffer, 'utf8') > MAX_FRAME) { closeSession(s); return; }
    let pos;
    while ((pos = s.buffer.indexOf('\n')) >= 0) {
      const line = s.buffer.slice(0, pos).trim();
      s.buffer = s.buffer.slice(pos + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.id === undefined) continue; // Server notifications require no response.
      const key = idKey(obj.id);
      const waiter = s.pending.get(key);
      if (!waiter) continue;
      s.pending.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve(obj);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { s.stderr = (s.stderr + data).slice(-2048); });
  child.on('error', () => closeSession(s));
  child.on('exit', () => closeSession(s));
  return s;
}
function forward(s, request) {
  s.lastAccess = Date.now();
  if (request.id === undefined) {
    s.child.stdin.write(JSON.stringify(request) + '\n');
    return Promise.resolve(null);
  }
  const key = idKey(request.id);
  if (s.pending.has(key)) return Promise.reject(new Error('Duplicate in-flight JSON-RPC id'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(key);
      reject(new Error('REA MCP response deadline exceeded'));
    }, DEADLINE_MS);
    s.pending.set(key, {timer, resolve, reject});
    s.child.stdin.write(JSON.stringify(request) + '\n', err => {
      if (err && s.pending.has(key)) {
        s.pending.delete(key);
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}
function validateMethod(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return 'Invalid JSON-RPC request';
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    if (typeof name !== 'string' || !allowed.has(name)) return 'REA tool is not on the approved allowlist';
  } else if (!['initialize', 'notifications/initialized', 'ping', 'tools/list'].includes(request.method)) {
    return 'This REA bridge exposes only approved tools';
  }
  return null;
}
const app = http.createServer(async (req, res) => {
  const route = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (route === '/health' && req.method === 'GET') {
    return send(res, 200, {ok: true, sessions: sessions.size});
  }
  if (route !== '/mcp') return send(res, 404, {error: 'Not found'});
  if (!authorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="REA MCP bridge"');
    return send(res, 401, {error: 'Bearer authentication required'});
  }
  if (req.method === 'DELETE') {
    const session = sessions.get(req.headers['mcp-session-id']);
    if (!session) return send(res, 404, {error: 'Unknown session'});
    closeSession(session);
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST') return send(res, 405, {error: 'Method not supported'});
  let input = '';
  try {
    for await (const chunk of req) {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_POST) return send(res, 413, {error: 'Request too large'});
    }
    const request = JSON.parse(input);
    if (Array.isArray(request)) return send(res, 400, jsonError(null, -32600, 'Batch requests not supported'));
    const invalid = validateMethod(request);
    if (invalid) return send(res, 403, jsonError(request?.id, -32601, invalid));
    const requestedSession = req.headers['mcp-session-id'];
    let session;
    let fresh = false;
    if (request.method === 'initialize') {
      if (requestedSession) return send(res, 400, jsonError(request.id, -32600, 'Initialize must start a new session'));
      if (sessions.size >= MAX_SESSIONS) return send(res, 429, {error: 'Session limit reached'});
      session = startSession();
      fresh = true;
      sessions.set(session.id, session);
    } else {
      session = sessions.get(requestedSession);
      if (!session) return send(res, 404, jsonError(request.id, -32001, 'Unknown MCP session'));
    }
    const reply = await forward(session, request);
    if (reply === null) { res.writeHead(202).end(); return; }
    if (request.method === 'tools/list' && Array.isArray(reply.result?.tools)) {
      reply.result.tools = reply.result.tools.filter(tool => allowed.has(tool.name));
    }
    if (fresh) send(res, 200, reply, {'Mcp-Session-Id': session.id});
    else send(res, 200, reply);
  } catch (err) {
    const reason = err instanceof SyntaxError ? 'Invalid JSON' : 'REA MCP transport failed';
    send(res, err instanceof SyntaxError ? 400 : 502, jsonError(null, -32000, reason));
  }
});
setInterval(() => {
  for (const s of sessions.values()) {
    if (Date.now() - s.lastAccess > IDLE_MS) closeSession(s);
  }
}, 60_000).unref();
app.listen(port, '127.0.0.1', () => {
  process.stderr.write('REA private MCP bridge on 127.0.0.1:' + port + '/mcp\n');
});
