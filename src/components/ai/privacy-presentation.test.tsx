import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/i18n';
import { PrivacyPresentation, PrivacyText, pendingPrivacyText } from './privacy-presentation';
import { renderMarkdown } from './markdown-renderer';
import { restorePrivacyText } from '@shared/ai-privacy';

const token = `STELA_PII_${'a'.repeat(24)}_${'b'.repeat(24)}`;
const privacy = { enabled: true, annotations: [{ token, original: '<script>alert("x")</script>|张三' }] };
const render = (text: string) => renderToStaticMarkup(<I18nextProvider i18n={i18n}><PrivacyPresentation privacy={privacy}>{renderMarkdown(text)}</PrivacyPresentation></I18nextProvider>);
for (const text of [`Hello ${token}`, `# ${token}`, `| name |\n| --- |\n| ${token} |`, `\`\`\`sql\nselect '${token}'\n\`\`\``]) {
  const html = render(text);
  assert(html.includes('stela-privacy-word')); assert(!html.includes('<script>')); assert(!html.includes(token));
}
const plain = renderToStaticMarkup(<I18nextProvider i18n={i18n}><PrivacyText text="张三" privacy={privacy} /></I18nextProvider>);
assert(!plain.includes('stela-privacy-word'), 'untransformed names must not receive inferred annotations');
assert.equal(pendingPrivacyText('hello ' + token.slice(0, -2)), 'hello ');
assert.equal(pendingPrivacyText(token), token);
assert.equal(restorePrivacyText(token, privacy.annotations), privacy.annotations[0]!.original);
console.log('privacy UI: Markdown structure, exact annotations, escaping, partial tokens and copy projection passed');
