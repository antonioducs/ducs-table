import { describe, expect, it } from "vitest";
import { adaptFilterModel, adaptSortModel, restoreFilterModel } from "./grid-adapter";
import type { ColumnInfo } from "@/types";

const columns: ColumnInfo[] = [
  { name: "name", type: "VARCHAR", nullable: true, ordinal: 1 },
  { name: "total", type: "DECIMAL(18,2)", nullable: false, ordinal: 2 },
  { name: "created_at", type: "TIMESTAMP", nullable: false, ordinal: 3 },
  { name: "paid", type: "BOOLEAN", nullable: true, ordinal: 4 },
];

describe("AG Grid adapter", () => {
  it("maps only known safe sort columns", () => {
    expect(adaptSortModel([
      { colId: "total", sort: "desc" },
      { colId: "not_a_column", sort: "asc" },
    ], columns)).toEqual([{ column: "total", direction: "desc" }]);
  });

  it("maps text, number, date and boolean models without SQL fragments", () => {
    const filters = adaptFilterModel({
      name: { filterType: "text", type: "contains", filter: "Ana" },
      total: { filterType: "number", type: "inRange", filter: 10, filterTo: 100 },
      created_at: { filterType: "date", type: "greaterThanOrEqual", dateFrom: "2026-01-01" },
      paid: { filterType: "text", type: "equals", filter: "true" },
      "name; DROP TABLE data": { filterType: "text", type: "equals", filter: "x" },
    }, columns);
    expect(filters).toEqual([
      { column: "name", type: "text", operator: "contains", value: "Ana" },
      { column: "total", type: "number", operator: "inRange", value: 10, valueTo: 100 },
      { column: "created_at", type: "date", operator: "greaterThanOrEqual", value: "2026-01-01" },
      { column: "paid", type: "boolean", operator: "equals", value: "true" },
    ]);
  });

  it("ignores unsupported operators", () => {
    expect(adaptFilterModel({ name: { filterType: "text", type: "rawSql", filter: "1=1" } }, columns)).toEqual([]);
  });

  it("restores normalized filters when a grid is remounted", () => {
    const filters = [
      { column: "name", type: "text" as const, operator: "contains" as const, value: "Ana" },
      { column: "total", type: "number" as const, operator: "inRange" as const, value: 10, valueTo: 100 },
      { column: "created_at", type: "date" as const, operator: "greaterThanOrEqual" as const, value: "2026-01-01" },
    ];

    expect(adaptFilterModel(restoreFilterModel(filters, columns), columns)).toEqual(filters);
  });
});
