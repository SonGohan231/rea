import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {join,dirname} from "node:path";
import {timingSafeEqual} from "node:crypto";

const require=createRequire(import.meta.url);
const KEY=process.env.REA_CONNECTOR_KEY||"";
const origins=new Set(["https://chatgpt.com","https://chat.openai.com"]);
function response(res,status,obj){res.statusCode=status;res.setHeader("cache-control","no-store");res.setHeader("content-type","application/json; charset=utf-8");res.end(JSON.stringify(obj));}
function error(id,code,message){return {jsonrpc:"2.0",id,error:{code,message}};}
function equals(a,b){const x=Buffer.from(String(a||""));const y=Buffer.from(String(b||""));return x.length>0&&x.length===y.length&&timingSafeEqual(x,y);}
function input(req){return new Promise((resolve,reject)=>{
  if(req.body!==undefined){resolve(req.body);return;}
  let s="";req.setEncoding("utf8");
  req.on("data",v=>{s+=v;if(s.length>2097152){reject(new Error("too large"));req.destroy();}});
  req.on("end",()=>{try{resolve(JSON.parse(s));}catch{reject(new Error("invalid JSON"));}});
  req.on("error",reject);
});}
function invoke(message){
  return new Promise((resolve,reject)=>{
    let rea;
    try{rea=join(dirname(require.resolve("rea-agents/package.json")),"scripts","rea.mjs");}
    catch(e){reject(e);return;}
    const child=spawn(process.execPath,[rea,"mcp"],{stdio:["pipe","pipe","pipe"],env:{...process.env,REA_MCP_MAX_RESPONSE_BYTES:"12000000"}});
    let count=0,buf="",stderr="",nextId=1,finished=false;
    const pending=new Map();
    const timer=setTimeout(()=>finish(new Error("REA timeout")),230000);
    timer.unref?.();
    function finish(err,result){
      if(finished)return;finished=true;clearTimeout(timer);child.kill("SIGTERM");
      if(err)reject(err);else resolve(result);
    }
    function write(o){try{child.stdin.write(JSON.stringify(o)+"\n");}catch(e){finish(e);}}
    function ask(method,params,callback){
      const id=nextId++;pending.set(id,callback);
      write({jsonrpc:"2.0",id,method,...(params===undefined?{}:{params})});
    }
    child.once("error",e=>finish(e));
    child.once("exit",(code,signal)=>finish(new Error("REA exited "+(code??signal)+": "+stderr.slice(-250))));
    child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-1600);});
    child.stdout.on("data",chunk=>{
      count+=chunk.length;if(count>12000000){finish(new Error("REA output too large"));return;}
      buf+=String(chunk);let n;
      while((n=buf.indexOf("\n"))>=0){
        const line=buf.slice(0,n);buf=buf.slice(n+1);
        let obj;try{obj=JSON.parse(line);}catch{continue;}
        if(obj.id===undefined)continue;
        const waiter=pending.get(obj.id);if(waiter){pending.delete(obj.id);waiter(obj);}
      }
    });
    ask("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"rea-vercel-bridge",version:"1.0.0"}},init=>{
      if(init.error){finish(new Error(init.error.message));return;}
      write({jsonrpc:"2.0",method:"notifications/initialized"});
      if(message.method==="initialize"){finish(null,{jsonrpc:"2.0",id:message.id,result:init.result});return;}
      ask(message.method,message.params,result=>finish(null,{...result,id:message.id}));
    });
  });
}
export default async function handler(req,res){
  const origin=String(req.headers.origin||"");
  if(origin&&!origins.has(origin))return response(res,403,{error:"origin_not_allowed"});
  if(origin){res.setHeader("access-control-allow-origin",origin);res.setHeader("vary","Origin");}
  if(req.method==="OPTIONS"){
    res.setHeader("access-control-allow-methods","POST,OPTIONS");
    res.setHeader("access-control-allow-headers","content-type,accept,authorization,mcp-protocol-version,mcp-session-id");
    res.statusCode=204;return res.end();
  }
  if(req.method!=="POST"){res.setHeader("allow","POST, OPTIONS");return response(res,405,{error:"method_not_allowed"});}
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(KEY))return response(res,503,{error:"server_not_configured"});
  const secret=req.query?.connector_key??new URL(req.url||"/","http://localhost").searchParams.get("connector_key");
  if(!equals(secret,KEY))return response(res,404,{error:"not_found"});
  if(Number(req.headers["content-length"]||0)>2097152)return response(res,413,{error:"too_large"});
  let msg;try{msg=await input(req);}catch{return response(res,400,error(null,-32700,"Parse error"));}
  if(!msg||Array.isArray(msg)||msg.jsonrpc!=="2.0"||typeof msg.method!=="string")return response(res,400,error(msg?.id??null,-32600,"Invalid Request"));
  if(msg.id===undefined){res.statusCode=202;return res.end();}
  try{return response(res,200,await invoke(msg));}
  catch(e){console.error("REA MCP failed:",String(e?.message||e).slice(0,350));return response(res,200,error(msg.id,-32603,"REA unavailable: "+String(e?.message||e).slice(0,350)));}
}
