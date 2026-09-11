import { z } from "zod";

export const agentMessageSchema = z.object({
            version: z.literal(1),
            segments: z.array(z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("text"), text: z.string().max(20_000) }).strict(),
              z.object({ kind: z.literal("resource"), resourceId: z.string().min(1).max(128) }).strict(),
            ])).max(128),
            resources: z.array(z.discriminatedUnion("kind", [
              z.object({
                id: z.string().min(1).max(128),
                kind: z.literal("table"),
                label: z.string().min(1).max(256),
                table: z.string().min(1).max(512),
                connectionName: z.string().max(256).nullable().optional(),
              }).strict(),
              z.object({
                id: z.string().min(1).max(128),
                kind: z.enum(["note", "canvas"]),
                label: z.string().min(1).max(256),
                path: z.string().min(1).max(8192),
              }).strict(),
              z.object({
                id: z.string().min(1).max(128),
                kind: z.literal("selection"),
                label: z.string().min(1).max(256),
                text: z.string().min(1).max(30_000),
                sourcePath: z.string().max(8192).optional(),
                locator: z.object({
                  blockId: z.string().max(256).nullable().optional(),
                  blockIndex: z.number().int().min(0).optional(),
                  keyword: z.string().max(30_000).optional(),
                  nthInFile: z.number().int().min(0).optional(),
                  line: z.number().int().min(1).optional(),
                  column: z.number().int().min(1).optional(),
                }).strict().optional(),
              }).strict(),
              z.object({
                id: z.string().min(1).max(128),
                kind: z.literal("runsql"),
                label: z.string().min(1).max(256),
                sql: z.string().min(1).max(30_000),
                sourcePath: z.string().max(8192).optional(),
                locator: z.object({
                  blockId: z.string().max(256).nullable().optional(),
                  blockIndex: z.number().int().min(0).optional(),
                  keyword: z.string().max(30_000).optional(),
                  nthInFile: z.number().int().min(0).optional(),
                  line: z.number().int().min(1).optional(),
                  column: z.number().int().min(1).optional(),
                }).strict().optional(),
                rewriteTargetId: z.string().min(1).max(256).optional(),
              }).strict(),
            ])).max(32),
          }).strict().superRefine((message, context) => {
            const ids = new Set(message.resources.map((resource) => resource.id));
            if (ids.size !== message.resources.length) {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent resource ids must be unique." });
            }
            if (message.segments.some((segment) => segment.kind === "resource" && !ids.has(segment.resourceId))) {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent message references an unknown resource." });
            }
            const textLength = message.segments.reduce((length, segment) =>
              length + (segment.kind === "text" ? segment.text.length : 0), 0);
            if (textLength > 20_000) {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent message text is too long." });
            }
          });
