import React from "react";
import { PrivacyReleaseCard } from "../../src/components/ai/privacy-release-card";
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/i18n";
const tokens = ['PII_12C', 'PII_12CD', `STELA_PII_${'d'.repeat(24)}_${'c'.repeat(24)}`];
const privacy = { enabled: true, annotations: tokens.map((token, i) => ({ token, original: ['张三', '13812345678', 'zhangsan@example.com'][i]! })) };
Object.assign(window, { stela: { agent: { onEvent: () => () => {} }, shell: { writeClipboardText: (text: string) => { document.documentElement.dataset.copied = text; } } } });
void i18n.changeLanguage('zh').then(async () => {
  const { AssistantMessage } = await import('../../src/components/ai/agent-panel');
  const { conversationTimeline } = await import('../../src/components/ai/conversation-timeline');
  const final = conversationTimeline({ id: 'task', input: '', connectionName: null, startedAt: 1, status: 'completed', runs: [], responses: [], events: [
    { type: 'final', runId: 'task', content: 'PII_4CF 数据分布', privacy: { enabled: true, annotations: [{ token: 'PII_4CF', original: '1001DESIGN' }] } },
    { type: 'skill_maintenance_started', runId: 'task', privacy: { enabled: true, annotations: [] } },
    { type: 'skill_maintenance', runId: 'task', outcome: 'unchanged', actions: [], summary: '', privacy: { enabled: true, annotations: [] } },
  ] }).find(entry => entry.kind === 'final')!;
  createRoot(document.getElementById('root')!).render(
  <main className="bg-background text-foreground min-h-screen p-6 max-w-3xl mx-auto">
    <h1 className="text-lg font-semibold mb-4">客户销售分析</h1>
    <AssistantMessage privacy={privacy} content={`已汇总 **${tokens[0]}** 的销售记录。金额与数量保持原值。\n\n| 客户 | 联系电话 | 销售额 |\n| --- | --- | --- |\n| ${tokens[0]} | ${tokens[1]} | 12,345.67 |\n\n联系邮箱：${tokens[2]}\n\n\`\`\`sql\nSELECT * FROM customers WHERE phone = '${tokens[1]}';\n\`\`\``} />
    {final.kind === 'final' && <AssistantMessage content={final.content} privacy={final.privacy} />}
    <PrivacyReleaseCard entry={{ privacy: final.privacy, kind: 'proposal', id: 'release', runId: 'task', callId: 'call', proposalKind: 'privacy_release', approvalMode: 'manual', resolution: 'pending', payload: {
      description: '需要根据商品名称判断家具类别。', privacyRelease: { sourceRunId: 'orders-query-1', sources: [1, 2, 3].map(i => ({ sourceRunId: `orders-query-${i}`, connectionName: 'demo', reason: `分析 PII_4CF 查询结果 ${i}` })), recipients: ['Example model / example.invalid'], options: [
        { id: '2', sourceRunId: 'orders-query-2', column: 0, path: [], label: '1. product', samples: ['会议桌'] },
        { id: '3', sourceRunId: 'orders-query-3', column: 0, path: [], label: '1. company', samples: ['示例公司'] },
        { id: '0', column: 0, path: [], label: '1. detail', samples: ['整列 JSON：包含商品和客户数据'] },
        { id: '1', column: 0, path: ['items', '*', 'name'], label: '1. detail / items / * / name', samples: ['星河办公椅', '天穹沙发'] },
      ] },
    } }} onRespond={async (_run, _call, approve, answer) => { document.documentElement.dataset.release = JSON.stringify({ approve, answer }); }} />
  </main>);
});
