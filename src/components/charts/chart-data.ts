import type { ColumnDef } from "@/contracts";
import { electronStorage } from "@/services/storage/electron-storage";
import {
  MAX_CHART_ROWS,
  StelaChartError,
  type StelaChartSpec,
  validateStelaChartData,
} from "@shared/chart-spec";

export interface StelaChartData {
  columns: ColumnDef[];
  rows: unknown[][];
  total: number;
  runId: string;
}

export async function loadStelaChartData(
  spec: StelaChartSpec,
  previousRunId?: string | null,
): Promise<StelaChartData> {
  const runId =
    spec.source.kind === "run"
      ? spec.source.runId
      : previousRunId ?? spec.source.fallbackRunId ?? null;
  if (!runId) {
    throw new StelaChartError("Run the query immediately above this chart to load its data.");
  }

  const read = async () => {
    const [columns, page] = await Promise.all([
      electronStorage.getSchema(runId),
      electronStorage.queryPage(runId, 0, MAX_CHART_ROWS + 1),
    ]);
    return { columns, rows: page.rows, total: page.total, runId };
  };

  let data = await read();
  if (data.columns.length === 0 || data.total === 0) {
    await window.stela.journal.importRun(runId);
    data = await read();
  }
  if (data.total > MAX_CHART_ROWS) {
    throw new StelaChartError(
      `The query returned ${data.total} rows; aggregate or filter it to at most ${MAX_CHART_ROWS} rows.`,
    );
  }
  validateStelaChartData(spec, data.columns, data.rows);
  return data;
}
