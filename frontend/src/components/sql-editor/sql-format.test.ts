import { describe, expect, it } from "vitest";
import { formatDuckDBSQL } from "./sql-format";

describe("DuckDB SQL formatting", () => {
  it("formats clauses and columns while preserving quoted identifiers and strings", async () => {
    const formatted = await formatDuckDBSQL(`select CDS,tamanho,"cod_modelo_cor",'select from where' as note from "estoque passo 07" where "qtd_total">0 and CDS is not null`);

    expect(formatted).toContain("SELECT\n  CDS,\n  tamanho,\n  \"cod_modelo_cor\"");
    expect(formatted).toContain("'select from where' AS note");
    expect(formatted).toContain('FROM\n  "estoque passo 07"');
    expect(formatted).toContain("WHERE\n  \"qtd_total\" > 0");
    expect(formatted).toContain("AND CDS IS NOT NULL");
  });

  it("leaves an empty draft untouched", async () => {
    await expect(formatDuckDBSQL("   ")).resolves.toBe("   ");
  });
});
