import assert from "node:assert/strict";
import {spawn} from "node:child_process";
const port=30197, key="abcdefghijklmnopqrstuvwxyz123456";
const child=spawn(process.execPath,["server.mjs"],{env:{...process.env,PORT:String(port),REA_CONNECTOR_KEY:key},stdio:["ignore","pipe","pipe"]});
let logs=""; child.stdout.on("data",d=>logs+=String(d));child.stderr.on("data",d=>logs+=String(d));
const root="http://127.0.0.1:"+port;const mcp=root+"/mcp/"+key;
async function jsonRpc(method,id,params,session){
 const headers={"content-type":"application/json","accept":"application/json, text/event-stream"};
 if(session)headers["mcp-session-id"]=session;
 const response=await fetch(mcp,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.timeout(30000)});
 const raw=await response.text();
 const messages=raw.startsWith("event:") || raw.startsWith("data:")?raw.split("\n").filter(x=>x.startsWith("data:")).map(x=>JSON.parse(x.slice(5).trim())):[JSON.parse(raw)];
 return {response,data:messages.find(x=>x.id===id)||messages.at(-1)};
}
try{
 let ready=false;
 for(let i=0;i<90;i++){
   try{const r=await fetch(root+"/health",{signal:AbortSignal.timeout(1500)});if(r.ok){ready=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,1000));
 }
 assert(ready,"Backend did not become ready: "+logs.slice(-3000));
 assert.equal((await fetch(root+"/mcp/invalid")).status,404);
 const init=await jsonRpc("initialize",1,{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"rea-smoke",version:"1"}});
 assert(init.response.ok && init.data?.result?.serverInfo,"MCP initialize failed: "+JSON.stringify(init.data));
 const session=init.response.headers.get("mcp-session-id");
 const headers={"content-type":"application/json","accept":"application/json, text/event-stream"};
 if(session)headers["mcp-session-id"]=session;
 const notification=await fetch(mcp,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})});
 assert([200,202,204].includes(notification.status),"Notification failed: "+notification.status);
 const list=await jsonRpc("tools/list",2,{},session);
 assert(list.response.ok && Array.isArray(list.data?.result?.tools),"tools/list failed: "+JSON.stringify(list.data));
 assert(list.data.result.tools.length>0,"REA provided no tools");
 console.log(JSON.stringify({test:"PASS",upstream:init.data.result.serverInfo,tools:list.data.result.tools.length}));
}catch(error){console.error(error.stack||String(error));console.error(logs.slice(-3500));process.exitCode=1;}
finally{child.kill("SIGTERM");}
