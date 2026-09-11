import { agentMessageSchema } from "./agent-message-schema";
import { z } from "zod";
import type { AgentEvent, AgentProposalResponse, AgentMessageContent } from "./types";

export const CONVERSATION_EXTENSION = ".stela.chat";
export const conversationTurnSchema = z.object({
  id: z.string(), input: z.string(), message: agentMessageSchema.optional(), connectionName: z.string().nullable(), startedAt: z.number(),
  status: z.enum(["running", "completed", "error", "cancelled", "interrupted"]),
  error: z.string().optional(),
  events: z.array(z.custom<AgentEvent>((v) => typeof v === "object" && v !== null && typeof (v as {type?: unknown}).type === "string")),
  responses: z.array(z.object({ runId: z.string(), callId: z.string(), approve: z.boolean(), answer: z.string().optional() })),
  runs: z.array(z.object({ runId: z.string(), blockId: z.string(), sql: z.string(), queryLanguage: z.enum(["sql", "mongodb"]).optional(), status: z.enum(["ok", "err", "running"]), message: z.string().nullable(), startedAt: z.number(), elapsedMs: z.number(), rowCount: z.number(), connectionName: z.string(), notePath: z.string().nullable() })),
});
export const conversationSchema = z.object({
  kind: z.literal("stela-conversation"), version: z.literal(1), id: z.string(), title: z.string(),
  createdAt: z.number(), updatedAt: z.number(), connectionName: z.string().nullable(), draft: z.string(), draftMessage: agentMessageSchema.optional(),
  turns: z.array(conversationTurnSchema), sessionJsonl: z.string(),
});
export type ConversationDocument = z.infer<typeof conversationSchema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export interface IConversationSnapshot { path: string; etag: string; document: ConversationDocument; persistenceError?: string }
export interface IConversationSubmit { path: string; etag: string; requestId: string; input: string; message?: AgentMessageContent; connectionName: string | null }
export interface IConversationBridge {
  create(directory: string, title: string): Promise<IConversationSnapshot>;
  read(path: string): Promise<IConversationSnapshot>;
  draft(path: string, etag: string, draft: string, connectionName: string | null, draftMessage?: AgentMessageContent): Promise<IConversationSnapshot>;
  submit(input: IConversationSubmit): Promise<IConversationSnapshot>;
  cancel(path: string): Promise<void>;
  respond(path: string, response: AgentProposalResponse): Promise<void>;
  onChanged(callback: (snapshot: IConversationSnapshot) => void): () => void;
}
