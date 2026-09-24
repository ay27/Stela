import { createContext, useContext, type ReactNode } from 'react';
import { PRIVACY_TOKEN_SOURCE, restorePrivacyText, type IPrivacyDisplay } from '@shared/ai-privacy';
import { useT } from '@/i18n/use-t';

export const PrivacyDisplayContext = createContext<IPrivacyDisplay | undefined>(undefined);
export function PrivacyBadge() {
  const t = useT();
  return <span className="stela-privacy-badge" title={t('ai.privacy.hint')}>{t('ai.privacy.badge')}</span>;
}
export function PrivacyPresentation({ privacy, children }: { privacy?: IPrivacyDisplay; children: ReactNode }) {
  return <PrivacyDisplayContext.Provider value={privacy}>{children}</PrivacyDisplayContext.Provider>;
}
export function PrivacyText({ text, privacy: supplied }: { text: string; privacy?: IPrivacyDisplay }) {
  const context = useContext(PrivacyDisplayContext), t = useT();
  const privacy = supplied ?? context;
  if (!privacy?.annotations.length) return <>{text}</>;
  const originals = new Map(privacy.annotations.map(a => [a.token, a.original]));
  return <>{text.split(new RegExp(`(${PRIVACY_TOKEN_SOURCE})`, 'g')).map((part, i) => originals.has(part)
    ? <span key={i} className="stela-privacy-word" title={t('ai.privacy.restored')} tabIndex={0}>{originals.get(part)}</span>
    : part)}</>;
}
export function usePrivacyRestore() {
  const privacy = useContext(PrivacyDisplayContext);
  return (text: string) => restorePrivacyText(text, privacy?.annotations ?? []);
}
export function pendingPrivacyText(text: string): string {
  const start = text.lastIndexOf('STELA_PII_');
  return start >= 0 && /^STELA_PII_[a-f0-9_]*$/.test(text.slice(start)) && text.length - start < 59 ? text.slice(0, start) : text;
}
