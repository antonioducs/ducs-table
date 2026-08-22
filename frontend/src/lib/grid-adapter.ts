import type { FilterModel, IGetRowsParams, SortModelItem } from "ag-grid-community";
import type { ColumnInfo, RowFilter, RowSort } from "@/types";

type RawFilter = {
  filterType?: string;
  type?: string;
  filter?: unknown;
  filterTo?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  operator?: string;
  condition1?: RawFilter;
  condition2?: RawFilter;
};

const operators = new Set<RowFilter["operator"]>([
  "equals", "notEqual", "contains", "notContains", "startsWith", "endsWith",
  "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual", "inRange",
  "blank", "notBlank",
]);

function normalizedType(column: ColumnInfo, modelType?: string): RowFilter["type"] {
  const sqlType = column.type.toUpperCase();
  if (sqlType.includes("BOOL")) return "boolean";
  if (/(INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/.test(sqlType)) return "number";
  if (/(DATE|TIME)/.test(sqlType)) return "date";
  if (modelType === "number" || modelType === "date") return modelType;
  return "text";
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? (value as string | number | boolean | null)
    : undefined;
}

function adaptOne(column: ColumnInfo, model: RawFilter): RowFilter | undefined {
  const operator = model.type;
  if (!operator || !operators.has(operator as RowFilter["operator"])) return undefined;
  const type = normalizedType(column, model.filterType);
  const rawValue = type === "date" ? model.dateFrom ?? model.filter : model.filter;
  const rawValueTo = type === "date" ? model.dateTo ?? model.filterTo : model.filterTo;
  const value = primitive(rawValue);
  const valueTo = primitive(rawValueTo);
  if (operator !== "blank" && operator !== "notBlank" && value === undefined) return undefined;
  return {
    column: column.name,
    type,
    operator: operator as RowFilter["operator"],
    ...(value !== undefined ? { value } : {}),
    ...(operator === "inRange" && valueTo !== undefined && typeof valueTo !== "boolean" ? { valueTo } : {}),
  };
}

export function adaptFilterModel(
  filterModel: FilterModel | Record<string, unknown> | null | undefined,
  columns: readonly ColumnInfo[],
): RowFilter[] {
  if (!filterModel || typeof filterModel !== "object") return [];
  const known = new Map(columns.map((column) => [column.name, column]));
  const filters: RowFilter[] = [];
  for (const [columnName, value] of Object.entries(filterModel)) {
    const column = known.get(columnName);
    if (!column || !value || typeof value !== "object") continue;
    const raw = value as RawFilter;
    if (raw.operator && raw.operator !== "AND") continue;
    if (raw.condition1 || raw.condition2) {
      const first = raw.condition1 && adaptOne(column, raw.condition1);
      const second = raw.condition2 && adaptOne(column, raw.condition2);
      if (first) filters.push(first);
      if (second) filters.push(second);
      continue;
    }
    const adapted = adaptOne(column, raw);
    if (adapted) filters.push(adapted);
  }
  return filters;
}

export function adaptSortModel(
  sortModel: readonly SortModelItem[] | null | undefined,
  columns: readonly ColumnInfo[],
): RowSort[] {
  if (!sortModel) return [];
  const known = new Set(columns.map((column) => column.name));
  return sortModel.flatMap((item) =>
    known.has(item.colId) && (item.sort === "asc" || item.sort === "desc")
      ? [{ column: item.colId, direction: item.sort }]
      : [],
  );
}

export function adaptGetRowsParams(
  params: Pick<IGetRowsParams, "sortModel" | "filterModel">,
  columns: readonly ColumnInfo[],
): { sorts: RowSort[]; filters: RowFilter[] } {
  return {
    sorts: adaptSortModel(params.sortModel, columns),
    filters: adaptFilterModel(params.filterModel, columns),
  };
}
