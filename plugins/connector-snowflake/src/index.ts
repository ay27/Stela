import { createRequire } from "node:module";
import { join } from "node:path";
import type * as Snowflake from "snowflake-sdk";
import { CONNECTOR_PLUGIN_API_VERSION, PluginError, defineConnectorPlugin, type Connector, type QueryResult, type TableDescriptor } from "@stela/connector-plugin-sdk";

interface Config { account:string;username:string;password:string;warehouse:string;database:string;schema:string;role:string }
function config(raw:unknown):Config { const v=(raw ?? {}) as Record<string,unknown>,account=String(v.account || ""),username=String(v.username || "");
  if (!account || !username) throw new PluginError("bad_config","Snowflake account and username are required.");
  return {account,username,password:String(v.password || ""),warehouse:String(v.warehouse || ""),database:String(v.database || ""),schema:String(v.schema || "PUBLIC"),role:String(v.role || "")}; }
function driver():typeof Snowflake { const p=process.env.ELECTRON_RENDERER_URL ? join(process.cwd(),"package.json") : join((process as NodeJS.Process & {resourcesPath:string}).resourcesPath,"app.asar","package.json"); return createRequire(p)("snowflake-sdk") as typeof Snowflake; }
function identifier(value:string):string { return `"${value.replaceAll('"','""')}"`; }
async function withConnection<T>(raw:unknown,fn:(connection:Snowflake.Connection)=>Promise<T>):Promise<T> { const c=config(raw),connection=driver().createConnection({account:c.account,username:c.username,password:c.password,warehouse:c.warehouse || undefined,database:c.database || undefined,schema:c.schema,role:c.role || undefined});
  await new Promise<void>((resolve,reject)=>connection.connect(error=>error ? reject(error) : resolve()));
  try { return await fn(connection); } finally { await new Promise<void>(resolve=>connection.destroy(()=>resolve())); } }
async function statement(connection:Snowflake.Connection,sql:string):Promise<QueryResult> { const started=Date.now(); return new Promise<QueryResult>((resolve,reject)=>{
  connection.execute({sqlText:sql,complete:(error,stmt,rawRows)=>{
    if (error) { reject(new PluginError("query_failed",error.message)); return; }
    const columns=(stmt.getColumns() ?? []).map(col=>({name:col.getName(),typeName:col.getType()}));
    if (!columns.length) { resolve({kind:"mutation",affectedRows:stmt.getNumRows(),elapsedMs:Date.now()-started}); return; }
    const rows=(rawRows ?? []) as Record<string,unknown>[];
    resolve({kind:"query",columns,rows:rows.map(row=>columns.map(col=>row[col.name] ?? null)),elapsedMs:Date.now()-started});
  }});
}); }
async function run(raw:unknown,sql:string):Promise<QueryResult> { return withConnection(raw,connection=>statement(connection,sql)); }
function names(result:QueryResult,column:string):string[] { if (result.kind!=="query") return []; const index=result.columns.findIndex(c=>c.name.toLowerCase()===column); return index<0 ? [] : result.rows.map(row=>String(row[index])); }
class SnowflakeConnector implements Connector {
  meta() { return {kind:"snowflake",displayName:"Snowflake",dialect:"Snowflake",subprocess:false,
    configSchema:{type:"object",properties:{account:{type:"string"},username:{type:"string"},password:{type:"string",format:"password"},warehouse:{type:"string"},database:{type:"string"},schema:{type:"string"},role:{type:"string"}},required:["account","username"]},
    defaultConfig:{account:"",username:"",password:"",warehouse:"",database:"",schema:"PUBLIC",role:""}}; }
  async test(raw:unknown) { const started=Date.now(); await run(raw,"SELECT 1"); return {ok:true,latencyMs:Date.now()-started}; }
  execute(raw:unknown,sql:string):Promise<QueryResult> { return run(raw,sql); }
  async listDatabases(raw:unknown):Promise<string[]> { return names(await run(raw,"SHOW DATABASES"),"name"); }
  async listTables(raw:unknown,db?:string|null):Promise<string[]> { const c=config(raw),database=db || c.database; if (!database) return [];
    const result=await run(raw,`SHOW TABLES IN DATABASE ${identifier(database)}`); if (result.kind!=="query") return [];
    const nameIndex=result.columns.findIndex(col=>col.name.toLowerCase()==="name");
    const schemaIndex=result.columns.findIndex(col=>col.name.toLowerCase()==="schema_name");
    return result.rows.map(row=>schemaIndex>=0 ? `${String(row[schemaIndex])}.${String(row[nameIndex])}` : String(row[nameIndex])); }
  async describeTables(raw:unknown,tables:{database:string|null;table:string}[]):Promise<TableDescriptor[]> { const c=config(raw),results:TableDescriptor[]=[];
    for (const item of tables) { const database=item.database || c.database; if (!database) continue;
      const parts=item.table.split("."); const schema=parts.length>1 ? parts[0] : c.schema; const table=parts.length>1 ? parts.slice(1).join(".") : item.table;
      const r=await run(raw,`DESCRIBE TABLE ${identifier(database)}.${identifier(schema)}.${identifier(table)}`);
      results.push({database:item.database,table:item.table,columns:r.kind==="query" ? r.rows.map(row=>({name:String(row[0]),typeName:String(row[1])})) : [],ddlSnippet:null}); }
    return results; }
}
export default defineConnectorPlugin({apiVersion:CONNECTOR_PLUGIN_API_VERSION,create:()=>new SnowflakeConnector()});
