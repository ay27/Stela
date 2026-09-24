import { createRequire } from "node:module";
import { join } from "node:path";
import type { BigQuery } from "@google-cloud/bigquery";
import { CONNECTOR_PLUGIN_API_VERSION, PluginError, defineConnectorPlugin, type Connector, type QueryResult, type TableDescriptor } from "@stela/connector-plugin-sdk";

interface Config { projectId:string; location:string; maximumBytesBilled:string; credentials:string }
function config(raw:unknown):Config { const v=(raw ?? {}) as Record<string,unknown>; const projectId=String(v.projectId || "");
  if (!projectId) throw new PluginError("bad_config","BigQuery project ID is required.");
  const maximumBytesBilled=String(v.maximumBytesBilled || "1073741824");
  if (!/^\d+$/.test(maximumBytesBilled)) throw new PluginError("bad_config","Maximum bytes billed must be a non-negative integer.");
  return {projectId,location:String(v.location || "US"),maximumBytesBilled,credentials:String(v.credentials || "")}; }
function client(raw:unknown):BigQuery { const c=config(raw); const packagePath=process.env.ELECTRON_RENDERER_URL ? join(process.cwd(),"package.json") : join((process as NodeJS.Process & {resourcesPath:string}).resourcesPath,"app.asar","package.json");
  const ctor=createRequire(packagePath)("@google-cloud/bigquery") as typeof import("@google-cloud/bigquery");
  let credentials:Record<string,unknown>|undefined;
  if (c.credentials) { try { const value:unknown=JSON.parse(c.credentials); if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("not an object"); credentials=value as Record<string,unknown>; }
    catch { throw new PluginError("bad_config","Credentials must be service-account JSON, or left empty for application default credentials."); } }
  return new ctor.BigQuery({projectId:c.projectId,credentials}); }
function ident(value:string):string { return "`"+value.replaceAll("`","")+"`"; }
function value(cell:unknown):unknown { if (cell instanceof Date) return cell.toISOString(); if (typeof cell==="bigint") return cell.toString(); if (cell && typeof cell==="object" && "value" in cell) return (cell as {value:unknown}).value; return cell; }
async function run(raw:unknown,sql:string):Promise<QueryResult> { const c=config(raw), bigquery=client(raw), started=Date.now();
  try { const [job]=await bigquery.createQueryJob({query:sql,location:c.location,useLegacySql:false,maximumBytesBilled:c.maximumBytesBilled});
    const [rows,,response]=await job.getQueryResults();
    const fields=response?.schema?.fields ?? [];
    const columns=fields.length
      ? fields.map(f=>({name:String(f.name),typeName:String(f.type ?? "UNKNOWN")}))
      : Object.keys(rows[0] ?? {}).map(name=>({name,typeName:"UNKNOWN"}));
    if (!columns.length) return {kind:"mutation",affectedRows:Number(response?.numDmlAffectedRows || 0),elapsedMs:Date.now()-started};
    return {kind:"query",columns,rows:rows.map(row=>columns.map(col=>value(row[col.name]))),elapsedMs:Date.now()-started};
  } catch(error) { if (error instanceof PluginError) throw error; throw new PluginError("query_failed",(error as Error).message); } }
class BigQueryConnector implements Connector {
  meta() { return {kind:"bigquery",displayName:"BigQuery",dialect:"BigQuery",subprocess:false,
    configSchema:{type:"object",properties:{projectId:{type:"string"},location:{type:"string"},maximumBytesBilled:{type:"string",description:"Per-query billing limit in bytes"},credentials:{type:"string",format:"password",description:"Service-account JSON; leave empty for ADC"}},required:["projectId"]},
    defaultConfig:{projectId:"",location:"US",maximumBytesBilled:"1073741824",credentials:""}}; }
  async test(raw:unknown) { const started=Date.now(); await run(raw,"SELECT 1"); return {ok:true,latencyMs:Date.now()-started}; }
  execute(raw:unknown,sql:string):Promise<QueryResult> { return run(raw,sql); }
  async listDatabases(raw:unknown):Promise<string[]> { const [datasets]=await client(raw).getDatasets(); return datasets.map(d=>d.id ?? "").filter(Boolean); }
  async listTables(raw:unknown,db?:string|null):Promise<string[]> { if (!db) return []; const [tables]=await client(raw).dataset(db).getTables(); return tables.map(t=>t.id ?? "").filter(Boolean); }
  async describeTables(raw:unknown,tables:{database:string|null;table:string}[]):Promise<TableDescriptor[]> { const bq=client(raw),descriptors:TableDescriptor[]=[];
    for (const item of tables) { if (!item.database) continue; const [metadata]=await bq.dataset(item.database).table(item.table).getMetadata();
      descriptors.push({database:item.database,table:item.table,columns:(metadata.schema?.fields ?? []).map((f:{name?:string;type?:string;description?:string})=>({name:String(f.name),typeName:String(f.type ?? "UNKNOWN"),comment:f.description ?? null})),ddlSnippet:null}); }
    return descriptors; }
}
export default defineConnectorPlugin({apiVersion:CONNECTOR_PLUGIN_API_VERSION,create:()=>new BigQueryConnector()});
