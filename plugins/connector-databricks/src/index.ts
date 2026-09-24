import { createRequire } from "node:module";
import { join } from "node:path";
import type { DBSQLClient } from "@databricks/sql";
import { CONNECTOR_PLUGIN_API_VERSION, PluginError, defineConnectorPlugin, type Connector, type QueryResult, type TableDescriptor } from "@stela/connector-plugin-sdk";

interface Config { host:string;path:string;token:string;catalog:string;schema:string }
function config(raw:unknown):Config { const v=(raw ?? {}) as Record<string,unknown>,host=String(v.host || ""),path=String(v.path || ""),token=String(v.token || "");
  if (!host || !path || !token) throw new PluginError("bad_config","Databricks host, SQL warehouse HTTP path and token are required.");
  return {host,path,token,catalog:String(v.catalog || ""),schema:String(v.schema || "")}; }
function driver():typeof import("@databricks/sql") { const p=process.env.ELECTRON_RENDERER_URL ? join(process.cwd(),"package.json") : join((process as NodeJS.Process & {resourcesPath:string}).resourcesPath,"app.asar","package.json"); return createRequire(p)("@databricks/sql") as typeof import("@databricks/sql"); }
function ident(value:string):string { return "`"+value.replaceAll("`","``")+"`"; }
async function withSession<T>(raw:unknown,fn:(session:Awaited<ReturnType<DBSQLClient["openSession"]>>)=>Promise<T>):Promise<T> { const c=config(raw),client=new (driver().DBSQLClient)();
  await client.connect({host:c.host,path:c.path,token:c.token});
  try { const session=await client.openSession({initialCatalog:c.catalog || undefined,initialSchema:c.schema || undefined});
    try { return await fn(session); } finally { await session.close(); }
  } finally { await client.close(); } }
async function run(raw:unknown,sql:string):Promise<QueryResult> { const started=Date.now(); try { return await withSession(raw,async session=>{
  const operation=await session.executeStatement(sql); try { await operation.finished();
    const schema=await operation.getSchema(); const columns=(schema?.columns ?? []).map(col=>({name:col.columnName,typeName:String(col.typeDesc.types?.[0]?.primitiveEntry?.type ?? "UNKNOWN")}));
    if (!columns.length) { const status=await operation.status(); return {kind:"mutation",affectedRows:Number(status.numModifiedRows?.toString() ?? 0),elapsedMs:Date.now()-started}; }
    const data=await operation.fetchAll(); return {kind:"query",columns,rows:data.map(row=>columns.map(col=>(row as Record<string,unknown>)[col.name] ?? null)),elapsedMs:Date.now()-started};
  } finally { await operation.close(); }
}); } catch(error) { if (error instanceof PluginError) throw error; throw new PluginError("query_failed",(error as Error).message); } }
class DatabricksConnector implements Connector {
  meta() { return {kind:"databricks",displayName:"Databricks SQL",dialect:"Spark SQL",subprocess:false,
    configSchema:{type:"object",properties:{host:{type:"string"},path:{type:"string"},token:{type:"string",format:"password"},catalog:{type:"string"},schema:{type:"string"}},required:["host","path","token"]},
    defaultConfig:{host:"",path:"/sql/1.0/warehouses/",token:"",catalog:"",schema:""}}; }
  async test(raw:unknown) { const started=Date.now(); await run(raw,"SELECT 1"); return {ok:true,latencyMs:Date.now()-started}; }
  execute(raw:unknown,sql:string):Promise<QueryResult> { return run(raw,sql); }
  async listDatabases(raw:unknown):Promise<string[]> { const c=config(raw),r=await run(raw,c.catalog ? `SHOW SCHEMAS IN ${ident(c.catalog)}` : "SHOW CATALOGS"); return r.kind==="query" ? r.rows.map(row=>String(row[0])) : []; }
  async listTables(raw:unknown,db?:string|null):Promise<string[]> { const c=config(raw),schema=db || c.schema; if (!schema) return [];
    const target=c.catalog ? `${ident(c.catalog)}.${ident(schema)}` : ident(schema),r=await run(raw,`SHOW TABLES IN ${target}`);
    if (r.kind!=="query") return []; const index=r.columns.findIndex(col=>col.name.toLowerCase()==="tablename"); return r.rows.map(row=>String(row[index>=0 ? index : 0])); }
  async describeTables(raw:unknown,tables:{database:string|null;table:string}[]):Promise<TableDescriptor[]> { const c=config(raw),descriptors:TableDescriptor[]=[];
    for (const item of tables) { const schema=item.database || c.schema; if (!schema) continue; const table=c.catalog ? `${ident(c.catalog)}.${ident(schema)}.${ident(item.table)}` : `${ident(schema)}.${ident(item.table)}`;
      const r=await run(raw,`DESCRIBE TABLE ${table}`); descriptors.push({database:item.database,table:item.table,columns:r.kind==="query" ? r.rows.filter(row=>row[0] && !String(row[0]).startsWith("#")).map(row=>({name:String(row[0]),typeName:String(row[1] ?? "UNKNOWN"),comment:row[2] == null ? null : String(row[2])})) : [],ddlSnippet:null}); }
    return descriptors; }
}
export default defineConnectorPlugin({apiVersion:CONNECTOR_PLUGIN_API_VERSION,create:()=>new DatabricksConnector()});
