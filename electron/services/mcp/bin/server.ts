/**
 * MCP stdio server entry —— 独立 Node 子进程入口。
 *
 * 启动方式：
 *   - main 进程通过 `child_process.spawn("node", [out/mcp/server.cjs])` 做 health check
 *   - 外部 LLM client（Claude Desktop / Cursor）通过 mcp config snippet 自行 spawn
 *
 * 环境变量：
 *   - `STELA_VAULT_PATH`：必填，作为 active vault。child 仅服务这一个 vault。
 *   - `STELA_TRANSFORMERS_CACHE_DIR`：可选，覆盖 transformers.js 模型缓存路径
 *   - `STELA_EMBED_MODEL_ID`：可选，覆盖嵌入模型
 *
 * 协议：MCP over stdio JSON-RPC。第一行 stdout 输出 `__stela_mcp_ready` 让 main 探测。
 *
 * 安全：
 *   - 只读 vault，所有路径走 `ensureWithinVault`（见 tools.ts）
 *   - 单 vault 锁定，不接受运行期切换
 *   - 不暴露 spawn / write / delete 工具
 */

import process from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as knowledge from "../../knowledge";
import { loadAppSettings } from "../../settings-store";
import {
  TOOL_HANDLERS,
  TOOL_SCHEMAS,
  type ToolContext,
  type ToolName,
  listToolNames,
} from "../tools";

const READY_MARKER = "__stela_mcp_ready";

async function main(): Promise<void> {
  const vaultPath = process.env.STELA_VAULT_PATH;
  if (!vaultPath) {
    console.error("[stela-mcp] STELA_VAULT_PATH not set; exiting");
    process.exit(2);
  }
  // RAG 受 settings.knowledge.enabled 门控（默认 false）。MCP child 与 main 进程
  // 是两个 runtime，必须各自读 settings；开关切换不会实时同步——用户改 enabled
  // 后需要外部 LLM client 重新 spawn MCP 才会生效。
  const settings = await loadAppSettings(vaultPath).catch((err: unknown) => {
    console.error(
      "[stela-mcp] load settings failed; defaulting knowledge.enabled=false:",
      err instanceof Error ? err.message : err,
    );
    return null;
  });
  const knowledgeEnabled = settings?.knowledge.enabled === true;
  await knowledge.start(vaultPath, { enabled: knowledgeEnabled });
  const ctx: ToolContext = { vaultPath };

  const server = new Server(
    { name: "stela-mcp", version: "0.6.0" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: listToolNames().map((name) => ({
        name,
        description: TOOL_SCHEMAS[name].description,
        inputSchema: zodToJsonSchema(TOOL_SCHEMAS[name].inputSchema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const def = TOOL_SCHEMAS[name];
    if (!def) {
      throw new Error(`unknown tool: ${name}`);
    }
    const parsed = def.inputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      throw new Error(
        `invalid arguments for ${name}: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    try {
      const handler = TOOL_HANDLERS[name];
      const result = await handler(ctx, parsed.data);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: msg,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 第一行 stdout 输出 ready marker：main 进程的 health-check 等这个串
  // 注意：MCP transport 已经接管了 stdout JSON-RPC，所以我们打到 stderr。
  process.stderr.write(READY_MARKER + "\n");
}

/**
 * 极简 zod → JSON Schema 转换：只覆盖 TOOL_SCHEMAS 用到的基础类型。
 * 完整方案可换 `zod-to-json-schema` 包，但当前依赖更轻。
 */
function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  // zod 内部有 _def / typeName 字段；为了不引入额外依赖这里走 duck-typing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)?._def;
  if (!def) return { type: "object" };
  if (def.typeName === "ZodObject") {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      // optional 字段 _def.typeName === "ZodOptional"；其余必填
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((value as any)?._def?.typeName !== "ZodOptional"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        && (value as any)?._def?.typeName !== "ZodDefault") {
        required.push(key);
      }
    }
    const out: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) out.required = required;
    return out;
  }
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
    return zodToJsonSchema(def.innerType);
  }
  if (def.typeName === "ZodString") return { type: "string" };
  if (def.typeName === "ZodNumber") return { type: "number" };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodEnum") return { type: "string", enum: def.values };
  if (def.typeName === "ZodArray")
    return { type: "array", items: zodToJsonSchema(def.type) };
  return { type: "string" };
}

main().catch((err) => {
  console.error("[stela-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
