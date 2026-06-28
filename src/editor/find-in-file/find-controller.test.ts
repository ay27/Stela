/**
 * find-controller 单测。
 *
 *     npx tsx src/editor/find-in-file/find-controller.test.ts
 *
 * 覆盖：
 *   - rescan：keyword 命中数 + activeIndex clamp 行为
 *   - next / prev：wrap-around（末尾→0、头部→len-1）
 *   - replace：单条替换后命中数减一、activeIndex 顺延
 *   - replaceAll：倒序单事务，全部替换 → 命中归 0
 *   - replace 空 replacement = delete（保持 PM 文档合法）
 *
 * 由于本测试不挂真实 Milkdown / DOM，所以用一个**最小 EditorView mock**：
 *   - 共享真实 PM Schema + EditorState + tr 应用
 *   - dispatch(tr) 拿 tr.doc 重新构造 state（模拟 view.updateState）
 *   - nodeDOM / domAtPos / dispatch CM 等 reveal 副作用一律 no-op；测试只关心
 *     find-controller 对 store / 命中索引 / tr 的影响，不关心视觉。
 */

import { fileURLToPath } from "node:url";

import { Schema } from "@milkdown/prose/model";
import { EditorState, type Transaction } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

import {
  next,
  prev,
  refresh,
  replace,
  replaceAll,
  rescan,
} from "./find-controller";
import { useFindState } from "./use-find-state";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      toDOM: () => ["p", 0] as const,
    },
    code_block: {
      content: "text*",
      group: "block",
      code: true,
      attrs: { language: { default: "" } },
      toDOM: () => ["pre", ["code", 0]] as const,
    },
    text: { group: "inline" },
  },
});

interface MockView extends EditorView {
  /** 测试用：当前 state（dispatch 会更新） */
  _state: EditorState;
}

function mockView(initial: EditorState): MockView {
  const v = {
    get state() {
      return v._state;
    },
    _state: initial,
    dispatch(tr: Transaction) {
      v._state = v._state.apply(tr);
    },
    // reveal.ts 的副作用 mock 成 no-op
    nodeDOM: () => null,
    domAtPos: () => ({ node: null as unknown as Node, offset: 0 }),
    focus: () => {},
    coordsAtPos: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
    dom: { closest: () => null } as unknown as HTMLElement,
  } as unknown as MockView;
  return v;
}

function makeView(text: string): MockView {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
  return mockView(EditorState.create({ doc, schema }));
}

function plainText(view: MockView): string {
  return view.state.doc.textContent;
}

function resetStore(): void {
  useFindState.setState({
    isOpen: true,
    mode: "find",
    keyword: "",
    replacement: "",
    caseSensitive: false,
    activeIndex: -1,
    totalMatches: 0,
    focusToken: 0,
  });
}

function run(): Check[] {
  const out: Check[] = [];

  // 1) rescan：纯 PM doc 内 5 个匹配
  {
    resetStore();
    const view = makeView("foo bar foo baz foo qux foo end foo");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "foo" });
    rescan(opts);
    const s = useFindState.getState();
    out.push(
      expect(
        "rescan: 5 matches found, activeIndex clamped to 0",
        s.totalMatches === 5 && s.activeIndex === 0,
        `total=${s.totalMatches} active=${s.activeIndex}`,
      ),
    );
  }

  // 2) next / wrap-around
  {
    resetStore();
    const view = makeView("a foo b foo c foo");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "foo" });
    rescan(opts); // active=0, total=3
    next(opts); // 1
    next(opts); // 2
    next(opts); // wrap → 0
    const s = useFindState.getState();
    out.push(
      expect(
        "next: wrap-around 0→1→2→0",
        s.activeIndex === 0 && s.totalMatches === 3,
        `active=${s.activeIndex}`,
      ),
    );
  }

  // 3) prev / wrap-around
  {
    resetStore();
    const view = makeView("foo bar foo baz foo");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "foo" });
    rescan(opts); // active=0
    prev(opts); // wrap → 2
    const s = useFindState.getState();
    out.push(
      expect(
        "prev: wrap-around 0→2 (last)",
        s.activeIndex === 2,
        `active=${s.activeIndex}`,
      ),
    );
  }

  // 4) refresh：keyword 改了直接跳 0
  {
    resetStore();
    const view = makeView("xx foo yy foo zz foo");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "foo", activeIndex: 2 });
    rescan(opts); // 让 store 与 doc 一致
    next(opts); // wrap → 0
    refresh(opts);
    const s = useFindState.getState();
    out.push(
      expect(
        "refresh: keyword scan jumps to index 0",
        s.activeIndex === 0,
      ),
    );
  }

  // 5) replace：单条替换，doc 文本被改 + 命中数减一
  {
    resetStore();
    const view = makeView("foo foo foo");
    const opts = { getView: () => view };
    useFindState.setState({
      keyword: "foo",
      replacement: "bar",
    });
    rescan(opts); // active=0, total=3
    replace(opts); // 替换 "foo"@0 → "bar"
    const s = useFindState.getState();
    const text = plainText(view);
    out.push(
      expect(
        "replace: doc updated to 'bar foo foo'",
        text === "bar foo foo",
        `got=${text}`,
      ),
    );
    out.push(
      expect(
        "replace: total 3→2 after consuming match[0]",
        s.totalMatches === 2,
        `total=${s.totalMatches}`,
      ),
    );
  }

  // 6) replace：空 replacement = delete
  {
    resetStore();
    const view = makeView("foo bar foo");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "foo", replacement: "" });
    rescan(opts); // active=0
    replace(opts); // 删 "foo"@0 + 空格遗留？只删 "foo"，留下 " bar foo"
    const text = plainText(view);
    out.push(
      expect(
        "replace: empty replacement deletes match",
        text === " bar foo",
        `got='${text}'`,
      ),
    );
  }

  // 7) replaceAll：倒序单事务一次性全替
  {
    resetStore();
    const view = makeView("foo a foo b foo c foo");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "foo", replacement: "X" });
    rescan(opts); // total=4
    replaceAll(opts);
    const text = plainText(view);
    const s = useFindState.getState();
    out.push(
      expect(
        "replaceAll: all 4 matches replaced",
        text === "X a X b X c X",
        `got='${text}'`,
      ),
    );
    out.push(
      expect(
        "replaceAll: post-state total=0 active=-1",
        s.totalMatches === 0 && s.activeIndex === -1,
        `total=${s.totalMatches} active=${s.activeIndex}`,
      ),
    );
  }

  // 8) replaceAll：空 replacement → 全删
  {
    resetStore();
    const view = makeView("aa foo bb foo cc");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "foo", replacement: "" });
    rescan(opts);
    replaceAll(opts);
    const text = plainText(view);
    out.push(
      expect(
        "replaceAll: empty replacement removes all matches",
        text === "aa  bb  cc",
        `got='${text}'`,
      ),
    );
  }

  // 9) replace：keyword 为空 → no-op
  {
    resetStore();
    const view = makeView("foo bar");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "", replacement: "x" });
    replace(opts);
    out.push(
      expect(
        "replace: empty keyword no-op",
        plainText(view) === "foo bar",
      ),
    );
  }

  // 10) next：keyword 为空 → no-op，store 不动
  {
    resetStore();
    const view = makeView("foo");
    const opts = { getView: () => view };
    useFindState.setState({ keyword: "" });
    next(opts);
    const s = useFindState.getState();
    out.push(
      expect(
        "next: empty keyword keeps activeIndex=-1",
        s.activeIndex === -1 && s.totalMatches === 0,
      ),
    );
  }

  return out;
}

function main(): void {
  const checks = run();
  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`[ok]   ${c.name}`);
    } else {
      failed += 1;
      console.log(`[FAIL] ${c.name}${c.detail ? `\n       ${c.detail}` : ""}`);
    }
  }
  if (failed > 0) {
    console.error(`\nfind-in-file/find-controller tests FAILED (${failed}).`);
    process.exit(1);
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
