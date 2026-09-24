import { CONNECTOR_PLUGIN_API_VERSION, PluginError, defineConnectorPlugin, type Connector, type QueryResult, type TableDescriptor } from "@stela/connector-plugin-sdk";

interface Config { server:string; user:string; password:string; catalog:string; schema:string }
function config(raw:unknown):Config { const v=(raw ?? {}) as Record<string,unknown>;
  const server=String(v.server || "http://localhost:8080"), user=String(v.user || "");
  if (!/^https?:\/\//i.test(server) || !user) throw new PluginError("bad_config","Trino server URL and user are required.");
  return {server,user,password:String(v.password || ""),catalog:String(v.catalog || ""),schema:String(v.schema || "")}; }
function ident(value:string):string { return `"${value.replaceAll('"','""')}"`; }
interface TrinoPage { nextUri?:string; columns?:{name:string;type:string}[]; data?:unknown[][]; error?:{message:string}; updateCount?:number }
async function run(raw:unknown, sql:string):Promise<QueryResult> { const started=Date.now(),c=config(raw);
  const server=new URL(c.server); const headers:Record<string,string>={"X-Trino-User":c.user,"X-Trino-Source":"Stela"};
  if (c.catalog) headers["X-Trino-Catalog"]=c.catalog;
  if (c.schema) headers["X-Trino-Schema"]=c.schema;
  if (c.password) headers.Authorization=`Basic ${Buffer.from(`${c.user}:${c.password}`).toString("base64")}`;
  let columns:{name:string;typeName:string}[]=[]; const rows:unknown[][]=[]; let updateCount=0;
  let nextUrl=new URL("/v1/statement",server).toString(); let first=true;
  while (nextUrl) {
    const response=await fetch(nextUrl,{method:first ? "POST" : "GET",headers:first ? {...headers,"Content-Type":"text/plain; charset=utf-8"} : headers,body:first ? sql : undefined,redirect:"error"});
    if (!response.ok) throw new PluginError("query_failed",`Trino HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
    const page=await response.json() as TrinoPage;
    if (page.error) throw new PluginError("query_failed",page.error.message);
    if (page.columns) columns=page.columns.map(col=>({name:col.name,typeName:col.type}));
    if (page.data) rows.push(...page.data);
    if (typeof page.updateCount === "number") updateCount=page.updateCount;
    if (page.nextUri) { const next=new URL(page.nextUri); if (next.origin!==server.origin) throw new PluginError("query_failed","Trino nextUri changed origin; refusing to forward credentials."); nextUrl=next.toString(); }
    else nextUrl="";
    first=false;
  }
  return columns.length ? {kind:"query",columns,rows,elapsedMs:Date.now()-started} : {kind:"mutation",affectedRows:updateCount,elapsedMs:Date.now()-started};
}
class TrinoConnector implements Connector {
  meta() { return {kind:"trino",displayName:"Trino",dialect:"Trino",subprocess:false,
    configSchema:{type:"object",properties:{server:{type:"string"},user:{type:"string"},password:{type:"string",format:"password"},catalog:{type:"string"},schema:{type:"string"}},required:["server","user","catalog"]},
    defaultConfig:{server:"http://localhost:8080",user:"",password:"",catalog:"",schema:""}}; }
  async test(raw:unknown) { const started=Date.now(); await run(raw,"SELECT 1"); return {ok:true,latencyMs:Date.now()-started}; }
  execute(raw:unknown,sql:string):Promise<QueryResult> { return run(raw,sql); }
  async listDatabases(raw:unknown):Promise<string[]> { const c=config(raw); const r=await run(raw,c.catalog ? `SHOW SCHEMAS FROM ${ident(c.catalog)}` : "SHOW CATALOGS"); return r.kind==="query" ? r.rows.map(row=>String(row[0])) : []; }
  async listTables(raw:unknown,db?:string|null):Promise<string[]> { const c=config(raw); if (!c.catalog) throw new PluginError("bad_config","Trino catalog is required for table discovery.");
    const schema=db || c.schema || "default", r=await run(raw,`SHOW TABLES FROM ${ident(c.catalog)}.${ident(schema)}`); return r.kind==="query" ? r.rows.map(row=>String(row[0])) : []; }
  async describeTables(raw:unknown,tables:{database:string|null;table:string}[]):Promise<TableDescriptor[]> { const c=config(raw); if (!c.catalog) return [];
    const result:TableDescriptor[]=[]; for (const item of tables) { const schema=item.database || c.schema || "default"; const r=await run(raw,`DESCRIBE ${ident(c.catalog)}.${ident(schema)}.${ident(item.table)}`);
      result.push({database:item.database,table:item.table,columns:r.kind==="query" ? r.rows.map(row=>({name:String(row[0]),typeName:String(row[1]),comment:row[3] == null ? null : String(row[3])})) : [],ddlSnippet:null}); }
    return result; }
}
export default defineConnectorPlugin({apiVersion:CONNECTOR_PLUGIN_API_VERSION,create:()=>new TrinoConnector()});
