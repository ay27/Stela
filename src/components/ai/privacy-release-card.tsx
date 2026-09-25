import { useState } from 'react';
import { useT } from '@/i18n/use-t';
import type { AgentTimelineEntry } from '@/state/agent-panel';
import { PrivacyPresentation, PrivacyText } from './privacy-presentation';

export function PrivacyReleaseCard({ entry, onRespond }: {
  entry: Extract<AgentTimelineEntry, { kind: 'proposal' }>;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const release = entry.payload.privacyRelease;
  if (!release) return null;
  const resolved = entry.resolution !== 'pending';
  const respond = async (approve: boolean, ids = selected) => {
    setSending(true); setFailed(false);
    try { await onRespond(entry.runId, entry.callId, approve, approve ? JSON.stringify(ids) : undefined); }
    catch { setFailed(true); }
    finally { setSending(false); }
  };
  let approved: string[] = [];
  try { const value: unknown = JSON.parse(entry.answer ?? '[]'); if (Array.isArray(value)) approved = value.filter((v): v is string => typeof v === 'string'); } catch { /* legacy response */ }
  return <PrivacyPresentation privacy={entry.privacy}><div className="stela-privacy-release rounded-lg border border-border bg-muted/20 p-3 text-sm">
    <div className="mb-2 font-medium">{t('ai.privacy.releaseTitle')}</div>
    {entry.payload.description && <p className="mb-2 whitespace-pre-wrap"><PrivacyText text={entry.payload.description} /></p>}
    <p className="mb-2 text-xs text-muted-foreground">{t('ai.privacy.releaseWarning')}</p>
    <p className="mb-2 break-all text-xs">{release.recipients.join(' · ')}</p>
    <div className="max-h-72 space-y-2 overflow-auto">
      {(release.sources ?? [{ sourceRunId: release.sourceRunId, connectionName: release.connectionName, reason: '' }]).map(source => <section key={source.sourceRunId} className="stela-privacy-release-source space-y-2">
        <p className="break-all text-xs text-muted-foreground">{[source.connectionName, source.sourceRunId].filter(Boolean).join(' · ')}</p>
        {source.reason && source.reason !== entry.payload.description && <p className="whitespace-pre-wrap text-xs"><PrivacyText text={source.reason} /></p>}
      {release.options.filter(option => (option.sourceRunId ?? release.sourceRunId) === source.sourceRunId).map(option => <label key={option.id} className="flex items-start gap-2 rounded border border-border p-2">
        <input type="checkbox" className="mt-1" disabled={resolved || sending}
          checked={resolved ? approved.includes(option.id) : selected.includes(option.id)}
          onChange={event => setSelected(current => event.target.checked ? [...current, option.id] : current.filter(id => id !== option.id))} />
        <span className="min-w-0"><span className="break-all font-mono text-xs">{option.label}</span>
          {!option.path.length && <span className="ml-2 text-xs text-muted-foreground">{t('ai.privacy.wholeColumn')}</span>}
          <span className="mt-1 block break-all text-xs text-muted-foreground">{option.samples.join(' · ') || t('ai.privacy.noSamples')}</span>
        </span>
      </label>)}
      </section>)}
    </div>
    {resolved ? <p className="mt-2 text-xs text-muted-foreground">{t(entry.resolution === 'expired' ? 'agent.panel.proposal.expired' : entry.resolution === 'approved' ? 'agent.panel.proposal.approved' : 'agent.panel.proposal.rejected')}</p>
      : <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" data-action="selected" disabled={!selected.length || sending} onClick={() => void respond(true)} className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50">{t('ai.privacy.releaseSelected')}</button>
        <button type="button" data-action="all" disabled={!release.options.length || sending} onClick={() => void respond(true, release.options.map(option => option.id))} className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50">{t('ai.privacy.releaseAll')}</button>
        <button type="button" data-action="deny" disabled={sending} onClick={() => void respond(false)} className="rounded border border-border px-3 py-1 text-xs">{t('ai.privacy.rejectAll')}</button>
      </div>}
    {failed && <p role="alert" className="mt-2 text-xs text-destructive">{t('ai.privacy.releaseFailed')}</p>}
  </div></PrivacyPresentation>;
}
