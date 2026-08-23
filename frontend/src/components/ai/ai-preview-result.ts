export interface AIPreviewResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  bytes: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function readAIPreviewResult(value: unknown): AIPreviewResult | undefined {
  const candidate = object(value);
  if (!candidate || !Array.isArray(candidate.columns) || !candidate.columns.every((column) => typeof column === "string") || !Array.isArray(candidate.rows)) return undefined;
  const rows = candidate.rows.map(object);
  if (rows.some((row) => !row)) return undefined;
  return {
    columns: candidate.columns,
    rows: rows as Record<string, unknown>[],
    truncated: candidate.truncated === true,
    bytes: typeof candidate.bytes === "number" && Number.isFinite(candidate.bytes) ? Math.max(0, candidate.bytes) : 0,
  };
}
