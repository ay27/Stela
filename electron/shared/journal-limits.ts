/**
 * 执行历史在"本机 SQLite"与"跨设备 JSONL"两侧的体积上限。
 *
 * 单次 SELECT 拿出几十万行（曾观测 82w 行 / 378MB）会让两侧都遭殃：
 *   - 本机 SQLite：result_rows 表暴涨、Settings → Persistence 的 DB size 失控
 *   - JSONL：单行不可切，rotation 救不了；Git push 会被超大 blob 卡死
 *
 * 统一策略：rows JSON 字节超过 `MAX_INLINE_RESULT_BYTES` 时**两侧都截断**。
 *   - renderer 端 execution：跳过 saveRows、record.message 标注 truncated
 *   - main 端 journal append：buildJournalLine 检测整行字节，再做兜底截断
 *
 * 阈值定 1MB 的依据：
 *   - 普通宽表单行 ~1KB → 1MB 装 ~1000 行，覆盖 99% 日常 run
 *   - Git 对 blob/diff 的舒适区在百 KB ~ 几 MB；超出后 push/diff 体感明显变差
 *   - SQLite WAL 也能装但本地查询缓存的初衷是"加速重看"，单条几十万行的重看
 *     场景本来就要分页拉远端，不靠本地缓存
 */
export const MAX_INLINE_RESULT_BYTES = 1 * 1024 * 1024;

/** record.message 标注 truncated 时的统一前缀，方便 UI / log 识别。 */
export const TRUNCATED_MESSAGE_PREFIX = "[stela] rows truncated";
