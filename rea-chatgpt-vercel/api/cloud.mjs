import {put, list, get, del} from "@vercel/blob";
import {randomUUID, createHash, timingSafeEqual} from "node:crypto";
import {Readable} from "node:stream";

const PREFIX = "rea/";
const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const MAX_MCP_BYTES = 512 * 1024;
const ID_PATTERN = /^rea\/[0-9a-f-]{36}\/[A-Za-z0-9_.-]{1,100}$/;

export const CLOUD_TOOLS = [
  {
    name: "cloud_upload_base64",
    description: "Upload a small binary or text file to private Vercel Blob. Takes base64 bytes (up to 512 KiB). For larger files use the secure web upload page.",
    inputSchema: {type:"object",properties:{filename:{type:"string",description:"Original filename with extension"},base64:{type:"string",description:"Base64-encoded file contents"}},required:["filename","base64"],additionalProperties:false}
  },
  {
    name: "cloud_list_files",
    description: "List files stored in REA's private cloud workspace. No Ubuntu filesystem is accessed.",
    inputSchema: {type:"object",properties:{limit:{type:"integer",minimum:1,maximum:100,default:50}},additionalProperties:false}
  },
  {
    name: "cloud_inspect_file",
    description: "Read a private uploaded file and report SHA-256, byte length, signature-based type, and safe executable-header metadata without executing it.",
    inputSchema: {type:"object",properties:{file_id:{type:"string"}},required:["file_id"],additionalProperties:false}
  },
  {
    name: "cloud_extract_strings",
    description: "Extract printable ASCII strings from an uploaded binary file in the cloud, without running executable content.",
    inputSchema: {type:"object",properties:{file_id:{type:"string"},minimum_length:{type:"integer",minimum:4,maximum:32,default:5},limit:{type:"integer",minimum:1,maximum:200,default:60}},required:["file_id"],additionalProperties:false}
  },
  {
    name: "cloud_read_text",
    description: "Read a bounded UTF-8 preview from an uploaded text file. Never executes uploaded code.",
    inputSchema: {type:"object",properties:{file_id:{type:"string"},max_chars:{type:"integer",minimum:1,maximum:12000,default:4000}},required:["file_id"],additionalProperties:false}
  },
  {
    name: "cloud_delete_file",
    description: "Permanently delete one selected file from REA's private Vercel Blob storage. Only run when the user requested deleting that file.",
    inputSchema: {type:"object",properties:{file_id:{type:"string"}},required:["file_id"],additionalProperties:false}
  }
];

export function authorized(key) {
  const expected = Buffer.from(String(process.env.REA_CONNECTOR_KEY || ""));
  const actual = Buffer.from(String(key || ""));
  return expected.length >= 32 && expected.length === actual.length && timingSafeEqual(expected, actual);
}

function safeFilename(name) {
  const sanitized = String(name || "file.bin").normalize("NFKD").replace(/[^A-Za-z0-9_.-]/g,"_").replace(/^\.+/,"").slice(0,96);
  return sanitized || "file.bin";
}

function checkId(fileId) {
  if (typeof fileId !== "string" || !ID_PATTERN.test(fileId)) throw new Error("Invalid REA file_id");
  return fileId;
}

function summary(blob) {
  return {file_id:blob.pathname, size:blob.size, uploaded_at:blob.uploadedAt || null};
}

export async function putFile(filename, bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_HTTP_BYTES) throw new Error("File must contain 1 to 4194304 bytes");
  const pathname = PREFIX + randomUUID() + "/" + safeFilename(filename);
  const obj = await put(pathname, bytes, {access:"private",contentType:"application/octet-stream",addRandomSuffix:false});
  return {file_id:obj.pathname || pathname, filename:safeFilename(filename), size:bytes.length, private:true};
}

export async function listFiles(limit=50) {
  const n = Number.isInteger(limit) ? Math.max(1,Math.min(100,limit)) : 50;
  const result = await list({prefix:PREFIX,limit:n});
  return {files:result.blobs.filter(b=>ID_PATTERN.test(b.pathname)).map(summary), has_more:result.hasMore || false};
}

export async function getFile(fileId) {
  checkId(fileId);
  const b = await get(fileId,{access:"private"});
  if (!b || b.statusCode === 404) throw new Error("File not found");
  if (b.statusCode && b.statusCode !== 200) throw new Error("Blob read failed");
  const bytes = Buffer.from(await new Response(b.stream).arrayBuffer());
  if (bytes.length > MAX_HTTP_BYTES) throw new Error("File exceeds maximum analysis size");
  return {bytes, filename:fileId.split("/").at(-1)};
}

function formatOf(b) {
  if (b.length>=4 && b.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))) {
    const types={2:"SPARC",3:"x86",40:"ARM",62:"x86-64",183:"AArch64",243:"RISC-V"};
    const machine=b.length>20 ? (b[5]===2 ? b.readUInt16BE(18):b.readUInt16LE(18)) : 0;
    return {format:"ELF",bits:b[4]===2?64:b[4]===1?32:null,endianness:b[5]===2?"big":"little",machine:types[machine]||machine};
  }
  if (b.length>64 && b.toString("ascii",0,2)==="MZ") {
    const pe=b.readUInt32LE(0x3c);
    if (pe>0 && pe+6<b.length && b.toString("ascii",pe,pe+4)==="PE\u0000\u0000") {
      const arches={0x14c:"x86",0x8664:"x86-64",0xaa64:"ARM64"};
      const machine=b.readUInt16LE(pe+4);
      return {format:"PE",machine:arches[machine]||machine};
    }
    return {format:"DOS-MZ",note:"No confirmed PE signature within uploaded bytes"};
  }
  if(b.length>=4) {
    const magic=b.toString("hex",0,4);
    if(["cffaedfe","feedfacf","cefaedfe","feedface"].includes(magic)) return {format:"Mach-O"};
    if(magic==="0061736d") return {format:"WebAssembly"};
    if(magic==="504b0304") return {format:"ZIP"};
    if(magic==="89504e47") return {format:"PNG"};
    if(magic==="25504446") return {format:"PDF"};
  }
  if (b.toString("ascii",0,4)==="dex\n") return {format:"Android DEX"};
  if (b.toString("ascii",0,3)==="GIF") return {format:"GIF"};
  return {format:"Unknown or plain data"};
}

function extractStrings(bytes,minLen,limit) {
  const output=[];
  let s="";
  function flush(){if(s.length>=minLen)output.push(s.slice(0,300));s="";}
  for (const c of bytes) {
    if(c>=32&&c<=126){s+=String.fromCharCode(c);if(s.length>300)flush();}
    else flush();
    if(output.length>=limit)break;
  }
  if(output.length<limit)flush();
  return output.slice(0,limit);
}

export async function cloudCall(name,args={}) {
  if (!args || typeof args!=="object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  if(name==="cloud_list_files") return await listFiles(args.limit);
  if(name==="cloud_upload_base64") {
    const s=args.base64;
    if(typeof s!=="string" || s.length<1 || s.length>MAX_MCP_BYTES*4/3+8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length%4!==0) throw new Error("Invalid or oversized base64 data");
    const b=Buffer.from(s,"base64");
    if(b.byteLength>MAX_MCP_BYTES) throw new Error("Maximum base64 upload is 512 KiB");
    return await putFile(args.filename,b);
  }
  if(name==="cloud_delete_file") {
    const id=checkId(args.file_id);
    await del(id);
    return {deleted:id};
  }
  if(name==="cloud_inspect_file") {
    const id=checkId(args.file_id);
    const {bytes,filename}=await getFile(id);
    return {file_id:id,filename,size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),...formatOf(bytes),execution:"never"};
  }
  if(name==="cloud_extract_strings") {
    const id=checkId(args.file_id);
    const minimum_length=Math.max(4,Math.min(32,Number(args.minimum_length)||5));
    const limit=Math.max(1,Math.min(200,Number(args.limit)||60));
    const {bytes}=await getFile(id);
    return {file_id:id,count:0,strings:extractStrings(bytes,minimum_length,limit),scanned_bytes:bytes.length};
  }
  if(name==="cloud_read_text") {
    const id=checkId(args.file_id);
    const n=Math.max(1,Math.min(12000,Number(args.max_chars)||4000));
    const {bytes}=await getFile(id);
    return {file_id:id,preview:bytes.toString("utf8",0,Math.min(bytes.length,n*4)).slice(0,n),truncated:bytes.length>n};
  }
  throw new Error("Unknown cloud tool");
}

function json(res,status,data){
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});
  res.end(JSON.stringify(data));
}
async function readLimited(req,limit){
  let total=0;
  const parts=[];
  for await (const chunk of req) {
    total+=chunk.length;
    if(total>limit)throw new Error("Upload is larger than 4 MiB");
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
const UPLOAD_HTML = '<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>REA — pliki w chmurze</title><style>body{background:#101828;color:#edf3ff;font:16px system-ui;max-width:700px;margin:5vh auto;padding:24px}button,input{font:inherit;margin:12px 4px;padding:10px;border-radius:8px}button{cursor:pointer;background:#22d3ee;border:0;color:#061421}li{margin:10px 0;overflow-wrap:anywhere}small{color:#a3b2c9}a{color:#67e8f9}</style></head><body><h1>REA — prywatne pliki</h1><p>Prześlij plik do magazynu Vercel Blob (do 4 MiB). Pliki nie są publikowane.</p><input id="file" type="file"><button id="up">Prześlij</button><p id="status" role="status"></p><h2>Pliki w chmurze</h2><ul id="list"></ul><button id="refresh">Odśwież listę</button><script>const key=location.pathname.split("/").pop(),base="/files/"+encodeURIComponent(key),status=document.getElementById("status"),list=document.getElementById("list");async function load(){const r=await fetch(base,{cache:"no-store"});if(!r.ok){status.textContent="Błąd listowania";return;}const data=await r.json();list.replaceChildren();for(const f of data.files){const li=document.createElement("li");li.textContent=f.file_id+" ("+f.size+" B) ";const a=document.createElement("a");a.href="/download/"+encodeURIComponent(key)+"?id="+encodeURIComponent(f.file_id);a.textContent="Pobierz";li.appendChild(a);list.appendChild(li);}}document.getElementById("up").onclick=async()=>{const f=document.getElementById("file").files[0];if(!f){status.textContent="Wybierz plik";return;}if(f.size>4194304){status.textContent="Maksymalnie 4 MiB";return;}status.textContent="Przesyłanie...";try{const r=await fetch(base,{method:"PUT",headers:{"x-file-name":encodeURIComponent(f.name),"content-type":"application/octet-stream"},body:f});const x=await r.json();status.textContent=r.ok?"Zapisano: "+x.file_id:JSON.stringify(x);await load();}catch(e){status.textContent=String(e)}};document.getElementById("refresh").onclick=load;load();</script></body></html>';

export async function handleCloudHttp(req,res,path,searchParams) {
  const parts=path.split("/");
  const action=parts[1], key=parts.slice(2).join("/");
  if(!authorized(key)) return json(res,404,{error:"not_found"});
  try {
    if(action==="upload"&&req.method==="GET"){
      res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-robots-tag":"noindex, nofollow","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'"});
      return res.end(UPLOAD_HTML);
    }
    if(action==="files"&&req.method==="GET")return json(res,200,await listFiles(100));
    if(action==="files"&&req.method==="PUT"){
      const raw=String(req.headers["x-file-name"]||"file.bin").slice(0,400);
      let name;try{name=decodeURIComponent(raw)}catch{name="file.bin"}
      const n=Number(req.headers["content-length"]||0);
      if(n>MAX_HTTP_BYTES)return json(res,413,{error:"file_too_large"});
      const bytes=await readLimited(req,MAX_HTTP_BYTES);
      return json(res,201,await putFile(name,bytes));
    }
    if(action==="files"&&req.method==="DELETE") {
      const id=checkId(searchParams.get("id"));
      await del(id);
      return json(res,200,{deleted:id});
    }
    if(action==="download"&&req.method==="GET") {
      const id=checkId(searchParams.get("id"));
      const object=await get(id,{access:"private"});
      if(!object||object.statusCode===404)return json(res,404,{error:"file_not_found"});
      if(object.statusCode && object.statusCode!==200)return json(res,502,{error:"storage_read_failed"});
      const filename=id.split("/").at(-1);
      res.writeHead(200,{"content-type":"application/octet-stream","content-disposition":'attachment; filename="'+filename+'"',"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"});
      Readable.fromWeb(object.stream).pipe(res);
      return;
    }
    return json(res,405,{error:"method_not_allowed"});
  }catch(err){
    console.error("Private blob operation failed:",String(err?.message||err).slice(0,180));
    return json(res,400,{error:"cloud_file_operation_failed",message:String(err?.message||err).slice(0,120)});
  }
}
