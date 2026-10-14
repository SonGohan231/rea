import {createServer} from "node:http";
import mcp from "./api/mcp.mjs";

const server=createServer(async(req,res)=>{
  try {
    const u=new URL(req.url||"/","http://localhost");
    if(u.pathname==="/api/health"||u.pathname==="/health"){
      res.setHeader("content-type","application/json");
      res.setHeader("cache-control","no-store");
      res.statusCode=200;
      return res.end(JSON.stringify({service:"rea-chatgpt-vercel",status:/^[A-Za-z0-9_-]{32,128}$/.test(process.env.REA_CONNECTOR_KEY||"")?"adapter-configured":"missing-secret",transport:"streamable-http"}));
    }
    if(u.pathname==="/api/mcp"){
      req.query={connector_key:u.searchParams.get("connector_key")};
      return await mcp(req,res);
    }
    if(u.pathname.startsWith("/mcp/")){
      req.query={connector_key:u.pathname.slice("/mcp/".length)};
      return await mcp(req,res);
    }
    res.statusCode=404;res.end("Not Found");
  }catch(err){
    console.error("Request failure:",String(err?.message||err).slice(0,200));
    if(!res.headersSent){res.statusCode=500;res.end("Internal Server Error");}
  }
});
server.listen(Number(process.env.PORT||3000),"0.0.0.0");
