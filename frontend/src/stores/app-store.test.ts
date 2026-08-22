import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./app-store";
import type { ConnectionInfo, ExternalRelationInfo, Job, SourceInfo } from "@/types";

const source: SourceInfo = {
  id: "customers-id",
  displayName: "Customers",
  tableName: "customers",
  kind: "csv",
  rowCount: 2,
  status: "ready",
  isEphemeral: false,
  columns: [{ name: "customer_id", type: "BIGINT", nullable: false, ordinal: 1 }],
};

const job: Job = {
  id: "job-id",
  kind: "import",
  state: "running",
  stage: "Materializing",
  createdAt: "2026-08-20T12:00:00Z",
};

const connection: ConnectionInfo = {
  id: "connection-id", name: "Production", kind: "postgres", catalogName: "prod", autoConnect: false, hasSecret: true,
  status: "connected", createdAt: "2026-08-20T12:00:00Z", updatedAt: "2026-08-20T12:00:00Z",
  config: { postgres: { host: "db.internal", port: 5432, database: "app", username: "reader", sslMode: "require", connectTimeoutSeconds: 10, poolSize: 4 } },
};

const relation: ExternalRelationInfo = {
  id: "relation-id", connectionId: connection.id, provider: "postgres", catalog: "prod", schema: "public", name: "profiles", relationType: "table",
  qualifiedName: '"prod"."public"."profiles"', columns: [{ name: "id", type: "INTEGER", nullable: false, ordinal: 1 }], defaultOrder: ["id"], pagingStable: true,
};

describe("app store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().reset();
  });

  it("opens, selects and closes source tabs", () => {
    const state = useAppStore.getState();
    state.upsertSource(source);
    state.openTab(source.id);
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().activeTabId).toBe(`source:${source.id}`);

    useAppStore.getState().closeTab(`source:${source.id}`);
    expect(useAppStore.getState().tabs).toEqual([]);
    expect(useAppStore.getState().activeTabId).toBeUndefined();
  });

  it("upserts jobs without ever adding table rows to session state", () => {
    useAppStore.getState().upsertJob(job);
    useAppStore.getState().upsertJob({ ...job, state: "completed", progress: 1 });
    const state = useAppStore.getState();
    expect(state.jobs).toEqual([{ ...job, state: "completed", progress: 1 }]);
    expect("rows" in state).toBe(false);
    expect(JSON.stringify(state)).not.toContain("previewRows");
  });

  it("does not downgrade a ready source when a late preview event arrives", () => {
    useAppStore.getState().upsertSource(source);
    useAppStore.getState().upsertSource({ ...source, status: "preparing", previewRows: [{ customer_id: 1 }] });
    expect(useAppStore.getState().sources[0].status).toBe("ready");
    expect(useAppStore.getState().sources[0].previewRows).toBeUndefined();
  });

  it("keeps live relation tabs separate from local source tabs", () => {
    const state = useAppStore.getState();
    state.upsertSource(source); state.openTab(source.id); state.upsertConnection(connection); state.openExternalTab(relation);
    expect(useAppStore.getState().tabs.map((tab) => tab.kind)).toEqual(["dataset", "external"]);
    expect(useAppStore.getState().activeTabId).toBe(`external:${relation.id}`);
    useAppStore.getState().closeTab(`external:${relation.id}`);
    expect(useAppStore.getState().sources).toEqual([source]);
  });

  it("persists only lightweight preferences, never connections or credentials", () => {
    useAppStore.getState().upsertConnection(connection);
    useAppStore.getState().setPanel({ sqlCollapsed: true });
    const persisted = localStorage.getItem("ducs-table:preferences:v1") ?? "";
    expect(persisted).toContain("preferences");
    expect(persisted).not.toContain("db.internal");
    expect(persisted).not.toContain("Production");
    expect(persisted.toLowerCase()).not.toContain("password");
  });
});
