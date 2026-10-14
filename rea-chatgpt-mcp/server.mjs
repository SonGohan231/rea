import http from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const folder = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.REA_CONNECTOR_KEY;
if (!KEY || !/^[A-Za-z0-9_-]{32,128}$/.test(KEY)) {
  console.error("REA_CONNECTOR_KEY is required: 32-128 URL-safe characters.");
  process.exit(1);
}
const PORT = Number(process.env.PORT || 3000);
const BACKEND_PORT = Number(process.env.REA_BACKEND_PORT || 18761);
if (![PORT, BACKEND_PORT].every(p => Number.isInteger(p) && p > 0 && p < 65536) || PORT === BACKEND_PORT) process.exit(1);
const endpoint = "/mcp/" + KEY;
const backend = "http://127.0.0.1:" + BACKEND_PORT;
const allowedOrigins = new Set(["https://chatgpt.com","https://chat.openai.com","https://openai.com"]);
let gateway = null, stopping = false, restarts = 0;

function launchGateway() {
  const binary = path.join(folder, "node_modules/.bin/supergateway");
  const rea = process.execPath + " " + path.join(folder, "node_modules/rea-agents/scripts/rea.mjs") + " mcp";
  gateway = spawn(binary, [
    "--stdio",rea, "--outputTransport","streamableHttp", "--stateful",
    "--sessionTimeout","1200000", "--streamableHttpPath","/mcp",
    "--healthEndpoint","/health", "--host","127.0.0.1",
    "--port",String(BACKEND_PORT)
  ], {cwd:folder,env:{...process.env,SUPERGATEWAY_API_KEY:KEY},stdio:["ignore","pipe","pipe"]});
  gateway.stdout.on("data",d => console.log("[gateway]",String(d).slice(0,1200).trimEnd()));
  gateway.stderr.on("data",d => console.error("[gateway]",String(d).slice(0,1200).trimEnd()));
  gateway.on("error",e => console.error("Gateway startup:",e.message));
  gateway.on("exit",(code,signal) => {
    gateway=null;
    console.error("Gateway exit:",code,signal);
    if (!stopping) setTimeout(launchGateway,Math.min(15000,1000*2**Math.min(restarts++,4)));
  });
}
launchGateway();
function json(res,status,data) {
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req,res) => {
  try {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return json(res,403,{error:"origin_not_allowed"});
    const pathname = new URL(req.url||"/","http://localhost").pathname;
    if (pathname==="/" && req.method==="GET") return json(res,200,{service:"rea-chatgpt-mcp",transport:"streamable-http",health:"/health"});
    if (pathname==="/health" && req.method==="GET") {
      try {
        const probe=await fetch(backend+"/health",{signal:AbortSignal.timeout(2000)});
        return json(res,probe.ok?200:503,{status:probe.ok?"ready":"starting",upstream:probe.status});
      } catch { return json(res,503,{status:"starting"}); }
    }
    if (pathname!==endpoint) return json(res,404,{error:"not_found"});
    if (origin) res.setHeader("access-control-allow-origin",origin);
    res.setHeader("vary","Origin");
    if (req.method==="OPTIONS") {
      res.writeHead(204,{"access-control-allow-methods":"GET,POST,DELETE,OPTIONS","access-control-allow-headers":"content-type,accept,authorization,mcp-session-id,mcp-protocol-version,last-event-id"});
      return res.end();
    }
    if (!["GET","POST","DELETE"].includes(req.method)) return json(res,405,{error:"method_not_allowed"});
    if (Number(req.headers["content-length"]||0)>20*1024*1024) return json(res,413,{error:"request_too_large"});
    const headers=new Headers();
    for (const [k,v] of Object.entries(req.headers)) {
      if (v===undefined || ["host","connection","transfer-encoding","authorization","x-api-key","content-length"].includes(k)) continue;
      headers.set(k,Array.isArray(v)?v.join(", "):v);
    }
    headers.set("authorization","Bearer "+KEY);
    const upstream=await fetch(backend+"/mcp",{
      method:req.method,headers,body:req.method==="POST"?req:undefined,
      duplex:"half",signal:AbortSignal.timeout(300000)
    });
    const out={};
    for (const [k,v] of upstream.headers) if (!["connection","content-length","transfer-encoding","content-encoding","keep-alive"].includes(k)) out[k]=v;
    out["cache-control"]="no-store";
    res.writeHead(upstream.status,out);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on("error",e=>res.destroy(e)).pipe(res);
  } catch (e) {
    console.error("Proxy error:",e.message);
    if (!res.headersSent) return json(res,502,{error:"rea_backend_unavailable"});
    res.destroy(e);
  }
});
server.listen(PORT,"0.0.0.0",()=>console.log("REA adapter listening:",PORT));
function shutdown() {stopping=true;gateway?.kill("SIGTERM");server.close(()=>process.exit(0));}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
