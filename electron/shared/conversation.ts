import { privacyStateSchema } from "./ai-privacy";
import { agentMessageSchema } from "./agent-message-schema";
import { z } from "zod";
import type { AgentEvent, AgentProposalResponse, AgentMessageContent } from "./types";

export const conversationTaskSchema = z.object({
  entryPoint: z.enum(["chat", "runsql-fix", "runsql-rewrite", "runsql-ask", "schema-explain", "knowledge-maintenance", "canvas-refresh"]).optional(),
  canvasRefresh: z.object({ path: z.string().min(1).max(8192), sourceId: z.string().min(1).max(128).optional() }).strict().optional(),
  workspaceContext: z.object({ kind: z.enum(["note", "canvas"]), path: z.string().min(1).max(8192) }).strict().optional(),
}).strict().superRefine((task, ctx) => {
  if ((task.entryPoint === "canvas-refresh") !== !!task.canvasRefresh) ctx.addIssue({ code: "custom", message: "Canvas refresh requires its matching task scope." });
});
export type IConversationTask = z.infer<typeof conversationTaskSchema>;
export const CONVERSATION_EXTENSION = ".stela.chat";
export const conversationTurnSchema = z.object({
  id: z.string(), input: z.string(), message: agentMessageSchema.optional(), connectionName: z.string().nullable(), startedAt: z.number(),
  task: conversationTaskSchema.optional(),
  status: z.enum(["running", "completed", "error", "cancelled", "interrupted"]),
  error: z.string().optional(),
  events: z.array(z.custom<AgentEvent>((v) => typeof v === "object" && v !== null && typeof (v as {type?: unknown}).type === "string")),
  responses: z.array(z.object({ runId: z.string(), callId: z.string(), approve: z.boolean(), answer: z.string().optional() })),
  runs: z.array(z.object({ runId: z.string(), blockId: z.string(), sql: z.string(), queryLanguage: z.enum(["sql", "mongodb"]).optional(), status: z.enum(["ok", "err", "running"]), message: z.string().nullable(), startedAt: z.number(), elapsedMs: z.number(), rowCount: z.number(), connectionName: z.string(), notePath: z.string().nullable() })),
});
export const conversationSchema = z.object({
  kind: z.literal("stela-conversation"), version: z.union([z.literal(1), z.literal(2), z.literal(3)]), id: z.string(), title: z.string(),
  createdAt: z.number(), updatedAt: z.number(), connectionName: z.string().nullable(), draft: z.string(), draftMessage: agentMessageSchema.optional(),
  draftTask: conversationTaskSchema.optional(),
  turns: z.array(conversationTurnSchema), sessionJsonl: z.string(),
  privacy: privacyStateSchema.optional(),
});
export type ConversationDocument = z.infer<typeof conversationSchema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export interface IConversationSnapshot { temporary?: boolean; previousPath?: string; path: string; etag: string; document: ConversationDocument; persistenceError?: string }
export interface IConversationSubmit { task?: IConversationTask; locale?: "zh" | "en"; path: string; etag: string; requestId: string; input: string; message?: AgentMessageContent; connectionName: string | null }
export interface IConversationSummary { path: string; sessionId: string; title: string; updatedAt: number; temporary: boolean }
export interface IConversationBridge {
  temporary(title?: string): Promise<IConversationSnapshot>;
  recent(): Promise<IConversationSummary[]>;
  saveAs(path: string, etag: string, directory: string, title: string): Promise<IConversationSnapshot>;
  discard(path: string): Promise<void>;
  protect(paths: string[]): Promise<void>;
  importHistory(ref: { deviceSlug: string; sessionId: string }): Promise<IConversationSnapshot>;
  create(directory: string, title: string): Promise<IConversationSnapshot>;
  read(path: string): Promise<IConversationSnapshot>;
  draft(path: string, etag: string, draft: string, connectionName: string | null, draftMessage?: AgentMessageContent, task?: IConversationTask): Promise<IConversationSnapshot>;
  submit(input: IConversationSubmit): Promise<IConversationSnapshot>;
  cancel(path: string): Promise<void>;
  respond(path: string, response: AgentProposalResponse): Promise<void>;
  onChanged(callback: (snapshot: IConversationSnapshot) => void): () => void;
}
