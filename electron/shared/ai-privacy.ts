import { z } from 'zod';

export const privacyStateSchema = z.object({
  version: z.literal(1), namespace: z.string().regex(/^[a-f0-9]{24}$/),
  entries: z.array(z.object({ token: z.string().regex(/^STELA_PII_[a-f0-9]{24}_[a-f0-9]{24}$/), original: z.string(), kind: z.string() }).strict()),
}).strict();
export type IPrivacySessionState = z.infer<typeof privacyStateSchema>;
export interface IPrivacyAnnotation { token: string; original: string }
export interface IPrivacyDisplay { enabled: boolean; annotations: IPrivacyAnnotation[] }
export const PRIVACY_TOKEN_SOURCE = 'STELA_PII_[a-f0-9]{24}_[a-f0-9]{24}';

/** Local presentation only; never use this projection as model context. */
export function restorePrivacyText(text: string, annotations: readonly IPrivacyAnnotation[]): string {
  const values = new Map(annotations.map(a => [a.token, a.original]));
  return text.replace(new RegExp(PRIVACY_TOKEN_SOURCE, 'g'), token => values.get(token) ?? token);
}
