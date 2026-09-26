import { z } from 'zod';

const TOKEN_VALUE = '(?:STELA_PII_[a-f0-9]{24}_[a-f0-9]{24}|PII_[0-9A-F]{3,11})';
export const PRIVACY_TOKEN_SOURCE = `(?<![A-Za-z0-9_])${TOKEN_VALUE}(?![A-Za-z0-9_])`;
export const privacyStateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), namespace: z.string().regex(/^[a-f0-9]{24}$/),
  entries: z.array(z.object({ token: z.string().regex(new RegExp(`^${TOKEN_VALUE}$`)), original: z.string(), kind: z.string() }).strict()),
}).strict().refine(state => state.version === 2 || state.entries.every(entry => entry.token.startsWith('STELA_PII_')), 'Legacy maps require legacy tokens');
export type IPrivacySessionState = z.infer<typeof privacyStateSchema>;
export interface IPrivacyAnnotation { token: string; original: string }
export interface IPrivacyResultDisplay {
  runId: string;
  columns: Array<{ column: number; state: 'masked' | 'partial' | 'released' }>;
}
export interface IPrivacyDisplay { enabled: boolean; annotations: IPrivacyAnnotation[]; results?: IPrivacyResultDisplay[] }

/** Local presentation only; never use this projection as model context. */
export function restorePrivacyText(text: string, annotations: readonly IPrivacyAnnotation[]): string {
  const values = new Map(annotations.map(a => [a.token, a.original]));
  return text.replace(new RegExp(PRIVACY_TOKEN_SOURCE, 'g'), token => values.get(token) ?? token);
}

export interface IPrivacySelection { column: number; path: string[] }
export interface IPrivacyReleaseOption extends IPrivacySelection {
  id: string;
  sourceRunId?: string;
  label: string;
  samples: string[];
}
export interface IPrivacyReleaseRequest {
  sourceRunId: string;
  connectionName?: string;
  recipients: string[];
  options: IPrivacyReleaseOption[];
  /** Absent on legacy single-result proposals. */
  sources?: Array<{ sourceRunId: string; connectionName?: string; reason: string }>;
}
