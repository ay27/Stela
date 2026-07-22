import type { ColumnDef } from "@/contracts";

function normalizeCell(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function csvEscape(value: string | number | boolean | null): string {
  if (value === null) return "";
  const raw = String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
}

function xmlEscape(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toRecordRows(columns: ColumnDef[], rows: unknown[][]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, colIdx) => {
      record[column.name] = row[colIdx] ?? null;
    });
    return record;
  });
}

export function buildCsvContent(columns: ColumnDef[], rows: unknown[][]): string {
  const header = columns.map((c) => csvEscape(c.name)).join(",");
  const body = rows.map((row) => {
    return columns
      .map((_, colIdx) => csvEscape(normalizeCell(row[colIdx] ?? null)))
      .join(",");
  });
  // BOM helps Excel open UTF-8 CSV correctly.
  return `\uFEFF${[header, ...body].join("\r\n")}`;
}

export function buildJsonContent(columns: ColumnDef[], rows: unknown[][]): string {
  return JSON.stringify(toRecordRows(columns, rows), null, 2);
}

export function buildExcelXmlContent(columns: ColumnDef[], rows: unknown[][]): string {
  const headerCells = columns
    .map((column) => `<Cell><Data ss:Type="String">${xmlEscape(column.name)}</Data></Cell>`)
    .join("");
  const dataRows = rows
    .map((row) => {
      const cells = columns
        .map((_, colIdx) => {
          const normalized = normalizeCell(row[colIdx] ?? null);
          if (normalized === null) {
            return "<Cell><Data ss:Type=\"String\"></Data></Cell>";
          }
          if (typeof normalized === "number") {
            return `<Cell><Data ss:Type="Number">${normalized}</Data></Cell>`;
          }
          if (typeof normalized === "boolean") {
            return `<Cell><Data ss:Type="Boolean">${normalized ? 1 : 0}</Data></Cell>`;
          }
          return `<Cell><Data ss:Type="String">${xmlEscape(String(normalized))}</Data></Cell>`;
        })
        .join("");
      return `<Row>${cells}</Row>`;
    })
    .join("");

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Results">
  <Table>
   <Row>${headerCells}</Row>
   ${dataRows}
  </Table>
 </Worksheet>
</Workbook>`;
}
