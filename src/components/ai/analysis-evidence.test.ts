import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import zh from "../../i18n/locales/zh.json";
import { AnalysisEvidence } from "./analysis-evidence";
import type { IAnalysisSnapshot } from "../../../electron/shared/analysis-contract";

const i18n = i18next.createInstance();
await i18n.init({ lng: "zh", resources: { zh: { translation: zh } }, interpolation: { escapeValue: false } });
const render = (snapshot: IAnalysisSnapshot | null) => renderToStaticMarkup(
  React.createElement(I18nextProvider, { i18n }, React.createElement(AnalysisEvidence, { snapshot })));
assert.equal(render(null), "", "disabled/legacy result adds no evidence card");
const snapshot: IAnalysisSnapshot = { runId: "r", version: 1, generation: "g", status: "observed",
  missingClaims: ["granularity"], failedChecks: ["row-count"], claims: [],
  checks: [{ name: "invented-source", passed: true, sourceResolved: false }], sources: [],
  coverage: { state: "subset", total: 14860, processed: 989, unresolved: 0, unprocessed: 13871, source: "articles" },
  previousVersions: 0, truncated: false };
const subset = render(snapshot);
assert.match(subset, /子集或未完成/);
assert.match(subset, /989 \/ 14860/);
assert.match(subset, /待补定义.*granularity/);
assert.match(subset, /检查失败.*row-count/);
assert.match(subset, /来源未解析.*invented-source/);
assert.doesNotMatch(subset, /已覆盖绑定范围/);
const full = render({ ...snapshot, coverage: { ...snapshot.coverage, state: "full", processed: 14860, unprocessed: 0 } });
assert.match(full, /已覆盖绑定范围/);
assert.match(full, /不代表答案已验证/);
const operation = render({ ...snapshot,
  coverage: { ...snapshot.coverage, state: "unknown", reason: "population_unbound" },
  operationCoverage: { total: 989, success: 980, unresolved: 5, failed: 2, unprocessed: 2 } });
assert.match(operation, /尚未绑定任务总体/);
assert.match(operation, /成功 980 \/ 989/);
assert.match(operation, /未决 5.*失败 2.*未处理 2/);
assert.doesNotMatch(operation, /已覆盖绑定范围/);
console.log("analysis evidence rendering: hidden legacy, subset, unresolved references and non-certifying full coverage passed");
