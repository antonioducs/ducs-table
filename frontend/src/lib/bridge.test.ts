import { describe, expect, it } from "vitest";
import { normalizePreviewSource, normalizeProjectSession, normalizeProjectWorkspace, normalizeSource } from "./bridge";

describe("project bridge normalization", () => {
  it("maps backend SourceInfo fields while keeping preview rows transient", () => {
    const source = normalizeSource({
      id: "source-1", projectId: "project-1", displayName: "Orders", sqlName: "orders", sourceType: "csv", rowCount: 4, isEphemeral: false,
      columns: [], originalSql: "select * from orders", previewRows: [{ id: 1 }],
    });
    expect(source).toEqual(expect.objectContaining({ projectId: "project-1", tableName: "orders", kind: "csv", originalSQL: "select * from orders" }));
    expect(source.previewRows).toEqual([{ id: 1 }]);
    expect(normalizePreviewSource({ ...source, previewRows: [{ id: 1 }] }).previewRows).toEqual([{ id: 1 }]);
  });

  it("sanitizes backend sessions and preloads external workspace catalogs", () => {
    const session = normalizeProjectSession({
      version: 1,
      sqlDraft: "select 1",
      tabs: [{ id: "external:one", kind: "external", relationId: "one", title: "Orders" }],
      activeTabId: "missing",
      history: Array.from({ length: 24 }, (_, index) => ({ id: String(index), sql: `select ${index}`, ranAt: "", status: "success" as const })),
      resultSequence: 2,
    });
    expect(session.history).toHaveLength(20);
    expect(session.activeTabId).toBeUndefined();

    const workspace = normalizeProjectWorkspace({
      project: { id: "project-1", name: "Analytics", description: "", lastOpenedAt: "", createdAt: "", updatedAt: "" },
      sources: [], savedQueries: [], connections: [], session,
      externalRelations: [{ id: "one", connectionId: "conn", provider: "postgres", catalog: "prod", schema: "public", name: "orders", relationType: "table", qualifiedName: '"prod"."public"."orders"', columns: [], defaultOrder: [], pagingStable: false }],
    });
    expect(workspace.externalRelations).toHaveLength(1);
    expect(workspace.project.id).toBe("project-1");
  });
});
