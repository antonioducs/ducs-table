/**
 * Loads the formatter only when requested so it does not increase the initial
 * workbench bundle. DuckDB mode preserves the quoted identifiers and syntax
 * accepted by the database used by the application.
 */
export async function formatDuckDBSQL(sql: string): Promise<string> {
  if (!sql.trim()) return sql;
  const { format } = await import("sql-formatter");
  return format(sql, {
    language: "duckdb",
    keywordCase: "upper",
    tabWidth: 2,
    linesBetweenQueries: 1,
  });
}
