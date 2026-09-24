import React from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/i18n";
const tokens = ['a', 'b', 'c'].map(c => `STELA_PII_${'d'.repeat(24)}_${c.repeat(24)}`);
const privacy = { enabled: true, annotations: tokens.map((token, i) => ({ token, original: ['张三', '13812345678', 'zhangsan@example.com'][i]! })) };
Object.assign(window, { stela: { agent: { onEvent: () => () => {} }, shell: { writeClipboardText: (text: string) => { document.documentElement.dataset.copied = text; } } } });
void i18n.changeLanguage('zh').then(async () => {
  const { AssistantMessage } = await import('../../src/components/ai/agent-panel');
  createRoot(document.getElementById('root')!).render(
  <main className="bg-background text-foreground min-h-screen p-6 max-w-3xl mx-auto">
    <h1 className="text-lg font-semibold mb-4">客户销售分析</h1>
    <AssistantMessage privacy={privacy} content={`已汇总 **${tokens[0]}** 的销售记录。金额与数量保持原值。\n\n| 客户 | 联系电话 | 销售额 |\n| --- | --- | --- |\n| ${tokens[0]} | ${tokens[1]} | 12,345.67 |\n\n联系邮箱：${tokens[2]}\n\n\`\`\`sql\nSELECT * FROM customers WHERE phone = '${tokens[1]}';\n\`\`\``} />
  </main>);
});
