import { createRequire } from "node:module";
import { join } from "node:path";
import type * as Mssql from "mssql";
import { CONNECTOR_PLUGIN_API_VERSION, PluginError, defineConnectorPlugin, type Connector, type QueryResult, type TableDescriptor } from "@stela/connector-plugin-sdk";

interface Config { host:string;port:number;user:string;password:string;database:string;encrypt:boolean;trustServerCertificate:boolean }
function config(raw:unknown):Config { const v=(raw ?? {}) as Record<string,unknown>;
  const host=String(v.host || "localhost"),user=String(v.user || ""),port=Number(v.port || 1433);
  if (!user || !Number.isInteger(port) || port<1 || port>65535) throw new PluginError("bad_config","SQL Server user and valid port are required.");
  return {host,port,user,password:String(v.password || ""),database:String(v.database || "master"),encrypt:v.encrypt !== false && v.encrypt !== "false",trustServerCertificate:v.trustServerCertificate === true || v.trustServerCertificate === "true"}; }
function driver():typeof Mssql { const path=process.env.ELECTRON_RENDERER_URL ? join(process.cwd(),"package.json") : join((process as NodeJS.Process & {resourcesPath:string}).resourcesPath,"app.asar","package.json"); return createRequire(path)("mssql") as typeof Mssql; }
async function withPool<T>(raw:unknown, fn:(pool:Mssql.ConnectionPool)=>Promise<T>):Promise<T> { const c=config(raw), sql=driver();
  const pool=new sql.ConnectionPool({server:c.host,port:c.port,user:c.user,password:c.password,database:c.database,options:{encrypt:c.encrypt,trustServerCertificate:c.trustServerCertificate}});
  await pool.connect(); try { return await fn(pool); } finally { await pool.close(); } }
function ident(value:string):string { return "[" + value.replaceAll("]", "]]") + "]"; }
async function run(raw:unknown,query:string):Promise<QueryResult> { const started=Date.now(); try { return await withPool(raw,async pool=>{
  const result=await pool.request().query(query);
  if (!result.recordset) return {kind:"mutation",affectedRows:result.rowsAffected.reduce((a,b)=>a+b,0),elapsedMs:Date.now()-started};
  const columns=Object.keys(result.recordset.columns).map(name=>({name,typeName:typeof result.recordset.columns[name].type === "function" ? result.recordset.columns[name].type.name : "UNKNOWN"}));
  return {kind:"query",columns,rows:result.recordset.map(row=>columns.map(c=>row[c.name] ?? null)),elapsedMs:Date.now()-started};
}); } catch(error) { if (error instanceof PluginError) throw error; throw new PluginError("query_failed",(error as Error).message); } }
class SqlServerConnector implements Connector {
  meta() { return {kind:"sqlserver",displayName:"SQL Server",dialect:"T-SQL",subprocess:false,
    configSchema:{type:"object",properties:{host:{type:"string"},port:{type:"integer"},user:{type:"string"},password:{type:"string",format:"password"},database:{type:"string"},encrypt:{type:"boolean"},trustServerCertificate:{type:"boolean"}},required:["host","port","user"]},
    defaultConfig:{host:"localhost",port:1433,user:"",password:"",database:"master",encrypt:true,trustServerCertificate:false}}; }
  async test(raw:unknown) { const started=Date.now(); await run(raw,"SELECT 1"); return {ok:true,latencyMs:Date.now()-started}; }
  execute(raw:unknown,query:string):Promise<QueryResult> { return run(raw,query); }
  async listDatabases(raw:unknown):Promise<string[]> { const r=await run(raw,"SELECT name FROM sys.databases ORDER BY name"); return r.kind==="query" ? r.rows.map(row=>String(row[0])) : []; }
  async listTables(raw:unknown,db?:string|null):Promise<string[]> { const prefix=db ? `${ident(db)}.` : ""; const r=await run(raw,`SELECT TABLE_SCHEMA + '.' + TABLE_NAME FROM ${prefix}INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_SCHEMA,TABLE_NAME`); return r.kind==="query" ? r.rows.map(row=>String(row[0])) : []; }
  async describeTables(raw:unknown,tables:{database:string|null;table:string}[]):Promise<TableDescriptor[]> { const descriptors:TableDescriptor[]=[];
    for (const item of tables) { const parts=item.table.split("."); const schema=parts.length>1 ? parts[0] : "dbo", table=parts.length>1 ? parts[1] : item.table;
      const catalog=item.database ? ident(item.database)+"." : "";
      const r=await withPool(raw,pool=>pool.request().input("schema",schema).input("table",table).query(`SELECT COLUMN_NAME, DATA_TYPE FROM ${catalog}INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION`));
      descriptors.push({database:item.database,table:item.table,columns:r.recordset.map(row=>({name:String(row.COLUMN_NAME),typeName:String(row.DATA_TYPE)})),ddlSnippet:null}); }
    return descriptors; }
}
export default defineConnectorPlugin({apiVersion:CONNECTOR_PLUGIN_API_VERSION,create:()=>new SqlServerConnector()});
