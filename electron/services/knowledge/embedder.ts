/**
 * 本地 embedder：默认 `Xenova/multilingual-e5-small`（384 dim，118 语言，中英混合稳）。
 *
 * 路线选择：
 *   - 直接用 `@xenova/transformers` v2 的 pipelines API（自带 onnxruntime-node + tokenizer）
 *   - 模型文件首次启动按需下载到 transformers.js 默认缓存目录（`~/.cache/huggingface/`）
 *     用户也可在 Settings → Knowledge 切换 `STELA_LOCAL_MODELS_DIR` 指向 vendor 路径
 *   - **不**走 `transformers.env.localModelPath` 单点解码：第三方源更新 README 更稳
 *
 * 优雅降级：
 *   - 加载失败（无网络 + 本地无缓存 / onnxruntime-node 缺失）：embedder 进入 `disabled`
 *   - indexer 检测到 disabled 后仍可写入 chunks + fts，只是不写 vec0（用户走纯 BM25 检索）
 *   - 用户在 UI 上看到一条 banner，可触发 Rebuild Index 重试
 *
 * E5 family 的输入约定：
 *   - passage: `passage: ${text}`  → 索引侧
 *   - query:   `query: ${text}`    → 查询侧
 *   - 不带前缀：召回明显下降。所以这里固定加。
 *
 * 嵌入后做 L2 norm，让 `vec0 MATCH` 的 distance 与 cosine 一致（vec0 距离默认是 L2 squared）。
 */

import { createRequire } from "node:module";

import { AppError } from "@shared/errors";

import { getLogger } from "../logger";

const log = getLogger("knowledge-embedder");

const DEFAULT_MODEL_ID = "Xenova/multilingual-e5-small";
const DEFAULT_DIM = 384;
const MAX_SEQ_LENGTH = 512;
/**
 * indexer 调 embedBatch 单次最大批。
 *
 * 历史：曾设为 16，在 macOS arm64 上跑大 vault（>500 文件）时观察到 onnxruntime
 * 1.14 在 `BFCArena::Extend` 处 native trap（SIGTRAP / EXC_BREAKPOINT），堆栈：
 *   `OrtApis::Run → ExecuteGraph → ExecutionFrame → BFCArena::Alloc → CPUAllocator::Alloc`
 *
 * 推断：multilingual-e5-small 单层 attention `[B, H=12, S=512, S=512] × 4B`，
 * B=16 时峰值约 192 MB / 层 × 12 层 ≈ 2 GB 连续分配。Electron 主进程虚拟内存
 * 跑久了碎片化严重，连续大块分配失败 → ORT_ENFORCE 触发 abort，且非 JS 异常
 * 路径，V8 的 uncaughtException 接不到。
 *
 * 降到 4 后单层峰值 ≈ 48 MB，整体内存压力 4x 下降；吞吐慢约 4 倍（仍能在 1 分钟
 * 量级跑完 ~1500 chunk）。如果将来切到 GPU / ANE EP 再调回去。
 */
export const EMBED_BATCH_LIMIT = 4;

type FeatureExtractor = (
  text: string | string[],
  opts?: { pooling?: "mean" | "cls"; normalize?: boolean },
) => Promise<{
  data: Float32Array;
  dims: number[];
}>;

interface EmbedderRuntime {
  modelId: string;
  dim: number;
  /** transformers.js 返回的 pipeline 函数 */
  extractor: FeatureExtractor;
}

let runtime: EmbedderRuntime | null = null;
let initInFlight: Promise<EmbedderRuntime | null> | null = null;
let lastError: string | null = null;

/** 当前是否可用（嵌入向量可以正常算出）。indexer / retriever 据此决定是否走 vec0 路径。 */
export function isAvailable(): boolean {
  return runtime !== null;
}

export function currentModelId(): string {
  return runtime?.modelId ?? DEFAULT_MODEL_ID;
}

export function currentDim(): number {
  return runtime?.dim ?? DEFAULT_DIM;
}

export function getLastError(): string | null {
  return lastError;
}

/**
 * 触发懒加载。返回 runtime；加载失败返回 null（embedder 进入 disabled 模式）。
 * 多次调用复用同一个 in-flight promise。
 */
export async function ensureLoaded(): Promise<EmbedderRuntime | null> {
  if (runtime) return runtime;
  if (initInFlight) return initInFlight;
  initInFlight = (async () => {
    try {
      const req = createRequire(import.meta.url);
      // 动态 require 避免 vite 把 transformers 拉进 renderer bundle
      const mod = req("@xenova/transformers") as {
        pipeline: (
          task: string,
          model: string,
          options?: { quantized?: boolean },
        ) => Promise<FeatureExtractor>;
        env: {
          allowLocalModels: boolean;
          allowRemoteModels: boolean;
          cacheDir?: string;
        };
      };
      // 默认允许 remote + local。allowLocalModels = true 让用户可以放
      // 模型到 `STELA_LOCAL_MODELS_DIR` 离线运行。
      mod.env.allowLocalModels = true;
      mod.env.allowRemoteModels = true;
      if (process.env.STELA_TRANSFORMERS_CACHE_DIR) {
        mod.env.cacheDir = process.env.STELA_TRANSFORMERS_CACHE_DIR;
      }
      const modelId = process.env.STELA_EMBED_MODEL_ID || DEFAULT_MODEL_ID;
      log.info("loading embedder", { modelId });
      const extractor = await mod.pipeline("feature-extraction", modelId, {
        quantized: true,
      });
      // 探测维度：跑一次 hello world 拿 dims[2]
      const probe = await extractor(["query: hello"], {
        pooling: "mean",
        normalize: true,
      });
      const dim = probe.dims[probe.dims.length - 1] ?? DEFAULT_DIM;
      runtime = { modelId, dim, extractor };
      lastError = null;
      log.info("embedder ready", { modelId, dim });
      return runtime;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("embedder load failed (knowledge base will degrade to FTS5-only)", {
        err: msg,
      });
      lastError = msg;
      runtime = null;
      return null;
    } finally {
      initInFlight = null;
    }
  })();
  return initInFlight;
}

/**
 * 批量 passage embedding（索引侧）。texts 数量上限由调用方控制（EMBED_BATCH_LIMIT）。
 *
 * 失败策略：
 *   - 整批失败：自动 fallback 到逐条 embed，把出错那一条的 content preview 写入
 *     日志（content 截前 200 char，避免日志被巨段污染）。这样上游 indexer
 *     在 silent crash 之前至少能定位到肇事样本。
 *   - 逐条仍失败：把该位置填一个零向量并继续，让其余样本至少能进库。零向量在
 *     vec0 距离里永远很差，不会污染检索结果。
 */
export async function embedPassages(
  texts: string[],
): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  const rt = await ensureLoaded();
  if (!rt) return null;
  const inputs = texts.map((t) => `passage: ${truncate(t)}`);
  try {
    const out = await rt.extractor(inputs, {
      pooling: "mean",
      normalize: true,
    });
    return splitBatch(out.data, out.dims, rt.dim);
  } catch (batchErr) {
    const batchMsg =
      batchErr instanceof Error ? batchErr.message : String(batchErr);
    log.warn("embedPassages batch failed, falling back to per-item", {
      err: batchMsg,
      batchSize: texts.length,
    });
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      try {
        const single = await rt.extractor([inputs[i] ?? ""], {
          pooling: "mean",
          normalize: true,
        });
        const vecs = splitBatch(single.data, single.dims, rt.dim);
        const v = vecs[0];
        if (!v) throw new Error("empty embedding");
        out.push(v);
      } catch (itemErr) {
        const itemMsg =
          itemErr instanceof Error ? itemErr.message : String(itemErr);
        lastError = itemMsg;
        log.error("embedPassages per-item failed", {
          err: itemMsg,
          idx: i,
          chars: (texts[i] ?? "").length,
          preview: (texts[i] ?? "").slice(0, 200),
        });
        // 填零向量保住批整体不丢；indexer 仍能写下其余样本。
        out.push(new Float32Array(rt.dim));
      }
    }
    return out;
  }
}

/** 单条 query embedding（检索侧）。失败返回 null（retriever 走纯 BM25）。 */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const rt = await ensureLoaded();
  if (!rt) return null;
  try {
    const out = await rt.extractor([`query: ${truncate(text)}`], {
      pooling: "mean",
      normalize: true,
    });
    return splitBatch(out.data, out.dims, rt.dim)[0] ?? null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    log.error("embedQuery failed", { err: lastError });
    return null;
  }
}

/**
 * 单条 input 硬截字符上界。
 *
 * multilingual-e5-small 的 `max_position_embeddings = 512`，transformers.js 自带
 * truncation=true 会按 tokenizer 输出截到 512 token。但中文 SentencePiece ≈ 1
 * char/token，整段中文超过 512 char 时 tokenizer 会把后半截语义抛掉；既然
 * 反正用不上，干脆在喂进 model 之前就截，省一次 BPE 解码、也减少 onnxruntime
 * 一侧的临时 tensor 分配峰值。
 *
 * 1024 char 与 chunker 的 HARD_CHAR_CAP 对齐，正常 chunk 不会触发；这是兜底。
 */
function truncate(text: string): string {
  const HARD_CAP_CHARS = MAX_SEQ_LENGTH * 2;
  if (text.length <= HARD_CAP_CHARS) return text;
  return text.slice(0, HARD_CAP_CHARS);
}

function splitBatch(
  data: Float32Array,
  dims: number[],
  dim: number,
): Float32Array[] {
  // 通常 dims = [batchSize, seqLen, hiddenSize]，但 pooling=mean 后变 [batch, hidden]
  const batch =
    dims.length === 2 ? (dims[0] ?? 1) : Math.floor(data.length / dim);
  const out: Float32Array[] = [];
  for (let i = 0; i < batch; i += 1) {
    const slice = data.subarray(i * dim, (i + 1) * dim);
    out.push(new Float32Array(slice));
  }
  return out;
}

/** 测试 / 重建索引时用：把已加载的 pipeline 释放掉，下次 ensureLoaded 重新加载。 */
export function disposeEmbedder(): void {
  runtime = null;
  initInFlight = null;
  lastError = null;
}

/** 单测 / 手工 stub 用：直接注入一个假的 extractor（绕过 transformers）。 */
export function __setRuntimeForTest(rt: EmbedderRuntime | null): void {
  runtime = rt;
  initInFlight = null;
}

/** AppError 工厂，UI 层 catch 时可统一归一。 */
export function notLoadedError(): AppError {
  return new AppError(
    "embedder_not_loaded",
    `embedder is not available${lastError ? `: ${lastError}` : ""}`,
  );
}
