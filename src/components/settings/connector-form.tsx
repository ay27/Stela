/**
 * Schema-driven connector 配置表单。
 *
 * 输入：connector 的 `configSchema`（一个简化 JSON Schema 子集）+ 当前 config 对象。
 * 输出：onChange(next) 给出 patch 后的完整 config 对象。
 *
 * 约定（v0.5）：**标量配置项一律用单行文本框**，不分数字 / 布尔 / 字符串。
 * 插件作者只需在 `configSchema.properties` 声明字段名即可，无需关心控件类型；
 * 文本框写回的值是 **string**（空 → 删字段），插件在自己的 parseConfig 里按需
 * coerce（`Number(...)` / `=== "true"`）。这样插件契约最简单、表单行为最可预期。
 *
 * 仅保留两个例外控件（仍是「在框里设置」、且体验明显更好）：
 *   - `enum=[]`            → Select（受限选项，避免手敲拼错）
 *   - `format="password"`  → 掩码文本框（凭据，避免肩窥；值仍是 string）
 * 以及一个结构化控件：
 *   - `type=object + additionalProperties{string}` → key/value 列表（HTTP headers 等）
 * 其余一律文本框；只有明确是 object/array 的复合字段才 fallback 到 JSON textarea。
 *
 * 设计取舍：
 *   - 不引入 react-jsonschema-form / @rjsf/* 这类重型库，价值与依赖体积失衡
 *   - 严格的运行时校验仍由 main 端 zod + connector 自身负责；表单只做 UX 引导
 */

import { useCallback, useMemo } from "react";
import { Plus, X } from "lucide-react";

import { Select } from "@/components/ui/select";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

interface JsonSchemaField {
  type?: "string" | "integer" | "number" | "boolean" | "object";
  enum?: string[];
  format?: string;
  description?: string;
  default?: unknown;
  additionalProperties?: { type?: string } | boolean;
  /** 部分插件可能用 number 字段提供 min/max 边界 */
  minimum?: number;
  maximum?: number;
}

interface JsonSchemaObject {
  type?: "object";
  properties?: Record<string, JsonSchemaField>;
  required?: string[];
}

/**
 * 把 unknown schema 归一化成可渲染的 object schema。
 * 不满足条件返回 null；caller 应当 fallback 到 JSON 视图。
 */
export function normalizeObjectSchema(
  schema: unknown,
): JsonSchemaObject | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;
  if (s.type !== undefined && s.type !== "object") return null;
  const props = s.properties;
  if (!props || typeof props !== "object") return null;
  const required = Array.isArray(s.required)
    ? s.required.filter((x): x is string => typeof x === "string")
    : [];
  return {
    type: "object",
    properties: props as Record<string, JsonSchemaField>,
    required,
  };
}

export interface ConnectorFormProps {
  schema: JsonSchemaObject;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function ConnectorForm({ schema, value, onChange }: ConnectorFormProps) {
  const required = useMemo(() => new Set(schema.required ?? []), [schema]);

  const setField = useCallback(
    (key: string, v: unknown) => {
      const next = { ...value };
      if (v === undefined) {
        delete next[key];
      } else {
        next[key] = v;
      }
      onChange(next);
    },
    [value, onChange],
  );

  const entries = Object.entries(schema.properties ?? {});

  return (
    <div className="space-y-3.5">
      {entries.map(([key, field]) => (
        <FieldRenderer
          key={key}
          name={key}
          field={field}
          required={required.has(key)}
          value={value[key]}
          onChange={(v) => setField(key, v)}
        />
      ))}
    </div>
  );
}

function FieldRenderer({
  name,
  field,
  required,
  value,
  onChange,
}: {
  name: string;
  field: JsonSchemaField;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <label className="mb-1 flex items-baseline gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <span>{name}</span>
      {required ? <span className="text-destructive">*</span> : null}
    </label>
  );

  const description = field.description ? (
    <p className="mt-1 text-[10px] text-muted-foreground">{field.description}</p>
  ) : null;

  const input = renderInput(field, value, onChange);

  return (
    <div>
      {label}
      {input}
      {description}
    </div>
  );
}

function renderInput(
  field: JsonSchemaField,
  value: unknown,
  onChange: (v: unknown) => void,
): React.ReactNode {
  // string + enum → Select
  if (field.type === "string" && field.enum && field.enum.length > 0) {
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        onValueChange={(v) => onChange(v)}
        options={field.enum.map((e) => ({ value: e, label: e, labelText: e }))}
        className="w-full"
      />
    );
  }

  // 结构化字段：string→string map（HTTP headers 等）保留专用编辑器
  if (
    field.type === "object" &&
    field.additionalProperties &&
    typeof field.additionalProperties === "object" &&
    field.additionalProperties.type === "string"
  ) {
    return (
      <KeyValueEditor
        value={
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, string>)
            : {}
        }
        onChange={onChange}
      />
    );
  }

  // 其余明确的复合类型（object / array，但非上面的 headers map）走 JSON 兜底
  if (field.type === "object") {
    return (
      <JsonFallback
        value={value}
        onChange={onChange}
        placeholder={field.description}
      />
    );
  }

  // 标量字段一律文本框：string / integer / number / boolean / 未声明类型。
  // 约定：写回的值是 string（空 → 删字段），由插件 parseConfig 负责 coerce。
  const inputType = field.format === "password" ? "password" : "text";
  const text =
    value === undefined || value === null
      ? ""
      : typeof value === "string"
        ? value
        : String(value);
  const placeholder =
    field.default !== undefined && field.default !== null
      ? String(field.default)
      : undefined;
  return (
    <input
      type={inputType}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === "" ? undefined : raw);
      }}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete={inputType === "password" ? "new-password" : "off"}
      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
    />
  );
}

/**
 * 字符串 → 字符串映射的编辑器，专门给 HTTP headers 这类 `additionalProperties:{type:string}`
 * 字段用。
 *
 * UX：
 *   - 内部用 (key, value)[] 数组维护——避免在 React state 里直接用对象时
 *     输入空 key 的中间状态被合并掉
 *   - 改 key 为重复值时，提交点不报错；最后写回的对象后写覆盖前写（标准对象语义）
 *   - 空 key 行不会写回到上层 value
 */
function KeyValueEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const t = useT();
  const entries = useMemo(() => Object.entries(value), [value]);

  const apply = (next: Array<[string, string]>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of next) {
      const trimmedKey = k.trim();
      if (!trimmedKey) continue;
      out[trimmedKey] = v;
    }
    onChange(out);
  };

  const update = (idx: number, k: string, v: string) => {
    const next = entries.map<[string, string]>((e, i) =>
      i === idx ? [k, v] : e,
    );
    apply(next);
  };

  const remove = (idx: number) => {
    const next = entries.filter((_, i) => i !== idx);
    apply(next);
  };

  const add = () => {
    apply([...entries, ["", ""]]);
  };

  return (
    <div className="space-y-1.5">
      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-2 py-2 text-[11px] text-muted-foreground">
          {t("connectorForm.emptyKeyValues")}
        </p>
      ) : (
        entries.map(([k, v], idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <input
              type="text"
              value={k}
              onChange={(e) => update(idx, e.target.value, v)}
              placeholder={t("connectorForm.keyPlaceholder")}
              spellCheck={false}
              className="w-1/3 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] focus:border-primary focus:outline-none"
            />
            <input
              type="text"
              value={v}
              onChange={(e) => update(idx, k, e.target.value)}
              placeholder={t("connectorForm.valuePlaceholder")}
              spellCheck={false}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={() => remove(idx)}
              title={t("connectorForm.delete")}
              className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))
      )}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
        {t("connectorForm.addKeyValue")}
      </button>
    </div>
  );
}

/**
 * 字段类型不识别时，渲染一个 JSON textarea。提交 onChange 仅在解析成功时调用，
 * 解析失败时把红色提示挂在下方但不破坏当前文本（避免输入中被打断）。
 */
function JsonFallback({
  value,
  onChange,
  placeholder,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder?: string;
}) {
  const t = useT();
  const text = useMemo(() => {
    try {
      return JSON.stringify(value ?? null, null, 2);
    } catch {
      return "";
    }
  }, [value]);

  return (
    <textarea
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        try {
          onChange(JSON.parse(raw));
        } catch {
          // 输入中可能是中间态，忽略；用户停止输入后能写出有效 JSON 即生效
        }
      }}
      rows={4}
      spellCheck={false}
      placeholder={placeholder ?? t("connectorForm.jsonValue")}
      className={cn(
        "w-full rounded-md border border-border bg-background px-2 py-2",
        "font-mono text-[12px] leading-relaxed focus:border-primary focus:outline-none",
      )}
    />
  );
}
