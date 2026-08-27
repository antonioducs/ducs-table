import type { AIPreviewResult } from "./ai-preview-result";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

export function AIPreviewTable({ result }: { result: AIPreviewResult }) {
  return (
    <div className="ducs-selectable-text mt-2 overflow-hidden rounded-md border border-border bg-card" aria-label="Query preview">
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1 text-[9px] text-muted-foreground">
        <span>{result.rows.length} {result.rows.length === 1 ? "row" : "rows"}</span>
        <span aria-hidden="true">·</span>
        <span>{formatBytes(result.bytes)}</span>
        {result.truncated && <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-300">Preview truncated</span>}
      </div>
      <div className="max-h-56 overflow-auto">
        <table aria-label="Query preview data" className="w-max min-w-full border-collapse text-left font-mono text-[9px]">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>{result.columns.map((column, columnIndex) => <th key={`${columnIndex}:${column}`} scope="col" className="max-w-56 border-b border-r border-border px-2 py-1 font-semibold text-foreground last:border-r-0">{column}</th>)}</tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-background even:bg-muted/20">
                {result.columns.map((column, columnIndex) => {
                  const text = formatCell(row[column]);
                  const isNull = row[column] === null || row[column] === undefined;
                  return <td key={`${columnIndex}:${column}`} title={text} className={`max-w-56 truncate border-b border-r border-border/60 px-2 py-1 last:border-r-0 ${isNull ? "italic text-muted-foreground" : "text-foreground"}`}>{text}</td>;
                })}
              </tr>
            ))}
            {result.rows.length === 0 && <tr><td colSpan={Math.max(1, result.columns.length)} className="px-2 py-3 text-center text-muted-foreground">No rows returned</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
