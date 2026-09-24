import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { CONNECTOR_PLUGIN_API_VERSION, PluginError, defineConnectorPlugin, type Connector, type QueryResult, type TableDescriptor } from "@stela/connector-plugin-sdk";

interface Config { url: string; user: string; password: string; database: string }
function config(raw: unknown): Config {
  const value = (raw ?? {}) as Record<string, unknown>;
  const url = String(value.url || "http://localhost:8123");
  if (!/^https?:\/\//i.test(url)) throw new PluginError("bad_config", "ClickHouse URL must start with http:// or https://.");
  return { url, user: String(value.user || "default"), password: String(value.password || ""), database: String(value.database || "default") };
}
function client(raw: unknown): ClickHouseClient { const c=config(raw); return createClient({ url:c.url, username:c.user, password:c.password, database:c.database, request_timeout:60_000 }); }
function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
async function select(c: ClickHouseClient, sql: string): Promise<{columns:{name:string;typeName:string}[];rows:unknown[][]}> {
  const result = await c.query({ query:sql, format:"JSON" });
  const data = await result.json<Record<string,unknown>>();
  const meta = data.meta ?? [];
  return { columns:meta.map(m=>({name:m.name,typeName:m.type})), rows:data.data.map(row=>meta.map(m=>row[m.name] ?? null)) };
}
class ClickHouseConnector implements Connector {
  meta() { return {kind:"clickhouse",displayName:"ClickHouse",dialect:"ClickHouse",subprocess:false,
    configSchema:{type:"object",properties:{url:{type:"string"},user:{type:"string"},password:{type:"string",format:"password"},database:{type:"string"}},required:["url","user"]},
    defaultConfig:{url:"http://localhost:8123",user:"default",password:"",database:"default"}}; }
  async test(raw: unknown) { const c=client(raw), started=Date.now(); try { const result=await c.ping(); if (!result.success) throw new Error("ClickHouse ping failed"); return {ok:true,latencyMs:Date.now()-started}; } finally { await c.close(); } }
  async execute(raw: unknown, sql: string): Promise<QueryResult> { const c=client(raw), started=Date.now(); try {
    if (/^\s*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(sql)) { const result=await select(c,sql); return {kind:"query",...result,elapsedMs:Date.now()-started}; }
    const command=await c.command({query:sql}); return {kind:"mutation",affectedRows:Number(command.summary?.written_rows ?? 0),elapsedMs:Date.now()-started};
  } catch(error) { throw new PluginError("query_failed",(error as Error).message); } finally { await c.close(); } }
  async listDatabases(raw: unknown): Promise<string[]> { const c=client(raw); try { const r=await select(c,"SHOW DATABASES"); return r.rows.map(row=>String(row[0])); } finally { await c.close(); } }
  async listTables(raw: unknown, db?: string | null): Promise<string[]> { const c=client(raw); try { const r=await select(c,`SELECT name FROM system.tables WHERE database = ${literal(db || config(raw).database)} ORDER BY name`); return r.rows.map(row=>String(row[0])); } finally { await c.close(); } }
  async describeTables(raw: unknown, tables: {database:string|null;table:string}[]): Promise<TableDescriptor[]> { const c=client(raw); try { const results:TableDescriptor[]=[];
    for (const item of tables) { const db=item.database || config(raw).database; const r=await select(c,`SELECT name, type, comment FROM system.columns WHERE database = ${literal(db)} AND table = ${literal(item.table)} ORDER BY position`);
      results.push({database:item.database,table:item.table,columns:r.rows.map(row=>({name:String(row[0]),typeName:String(row[1]),comment:String(row[2] ?? "")})),ddlSnippet:null}); }
    return results;
  } finally { await c.close(); } }
}
export default defineConnectorPlugin({apiVersion:CONNECTOR_PLUGIN_API_VERSION,create:()=>new ClickHouseConnector()});
