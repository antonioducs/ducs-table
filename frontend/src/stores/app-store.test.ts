import { beforeEach, describe, expect, it } from "vitest";
import { preserveWorkspaceMutations, selectActiveSource, selectProjectJobs, useAppStore } from "./app-store";
import type { ConnectionInfo, ExternalRelationInfo, Job, Project, ProjectWorkspace, SourceInfo } from "@/types";

const project = (id: string, name = id): Project => ({
  id, name, description: "", lastOpenedAt: `2026-08-2${id === "p1" ? "1" : "0"}T12:00:00Z`, createdAt: "2026-08-20T12:00:00Z", updatedAt: "2026-08-20T12:00:00Z",
});

const source = (projectId: string, id = "customers-id"): SourceInfo => ({
  projectId,
  id,
  displayName: "Customers",
  tableName: "customers",
  kind: "csv",
  rowCount: 2,
  status: "ready",
  isEphemeral: false,
  columns: [{ name: "customer_id", type: "BIGINT", nullable: false, ordinal: 1 }],
});

const job = (projectId: string, id = `job-${projectId}`): Job => ({
  projectId, id, kind: "import", state: "running", stage: "Materializing", createdAt: "2026-08-20T12:00:00Z",
});

const connection: ConnectionInfo = {
  id: "connection-id", name: "Production", kind: "postgres", catalogName: "prod", autoConnect: false, hasSecret: true,
  status: "connected", createdAt: "2026-08-20T12:00:00Z", updatedAt: "2026-08-20T12:00:00Z",
  config: { postgres: { host: "db.internal", port: 5432, database: "app", username: "reader", sslMode: "require", connectTimeoutSeconds: 10, poolSize: 4 } },
};

const relation: ExternalRelationInfo = {
  id: "relation-id", connectionId: connection.id, provider: "postgres", catalog: "prod", schema: "public", name: "profiles", relationType: "table",
  qualifiedName: '"prod"."public"."profiles"', columns: [{ name: "id", type: "INTEGER", nullable: false, ordinal: 1 }], defaultOrder: ["id"], pagingStable: true,
};

const workspace = (value: Project, sources: SourceInfo[] = []): ProjectWorkspace => ({
  project: value,
  sources,
  savedQueries: [],
  connections: [],
  session: { version: 1, sqlDraft: "", tabs: [], history: [], resultSequence: 0 },
});

describe("normalized project store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().reset();
    useAppStore.getState().bootstrap({ projects: [project("p1"), project("p2")], activeProjectId: "p1", workspace: workspace(project("p1")), jobs: [] });
    useAppStore.getState().startProjectSwitch("p2");
    useAppStore.getState().commitProjectSwitch("p2", workspace(project("p2")));
    useAppStore.getState().startProjectSwitch("p1");
    useAppStore.getState().commitProjectSwitch("p1", workspace(project("p1")));
  });

  it("isolates sources, drafts, tabs, history, and result counters by project", () => {
    const state = useAppStore.getState();
    state.upsertSource("p1", source("p1", "one"));
    state.upsertSource("p2", source("p2", "two"));
    state.openTab("p1", "one");
    state.setDraft("p1", "select 1");
    state.setDraft("p2", "select 2");
    state.addHistory("p1", { sql: "select 1", status: "success" });

    const current = useAppStore.getState();
    expect(current.projectWorkspaces.p1.sourceIds).toEqual(["one"]);
    expect(current.projectWorkspaces.p2.sourceIds).toEqual(["two"]);
    expect(current.projectWorkspaces.p1.session.sqlDraft).toBe("select 1");
    expect(current.projectWorkspaces.p2.session.sqlDraft).toBe("select 2");
    expect(current.projectWorkspaces.p1.session.tabs[0].kind).toBe("local");
    expect(current.projectWorkspaces.p2.session.tabs).toEqual([]);
    expect(current.projectWorkspaces.p1.session.history).toHaveLength(1);
    expect(current.nextResultName("p1")).toBe("Result 1");
    expect(current.nextResultName("p2")).toBe("Result 1");
  });

  it("caps query history at 20 entries", () => {
    for (let index = 0; index < 25; index += 1) useAppStore.getState().addHistory("p1", { sql: `select ${index}`, status: "success" });
    const history = useAppStore.getState().projectWorkspaces.p1.session.history;
    expect(history).toHaveLength(20);
    expect(history[0].sql).toBe("select 24");
  });

  it("rejects a mismatched workspace response without changing the active project", () => {
    useAppStore.getState().startProjectSwitch("p2");
    expect(useAppStore.getState().commitProjectSwitch("p2", workspace(project("different")))).toBe(false);
    expect(useAppStore.getState().activeProjectId).toBe("p1");
  });

  it("routes inactive project events without changing current selection", () => {
    const before = useAppStore.getState().activeProjectId;
    useAppStore.getState().upsertSource("p2", source("p2", "background"));
    useAppStore.getState().openTab("p2", "background");
    expect(useAppStore.getState().activeProjectId).toBe(before);
    expect(useAppStore.getState().projectWorkspaces.p1.session.activeTabId).toBeUndefined();
    expect(useAppStore.getState().projectWorkspaces.p2.session.activeTabId).toBeUndefined();
    expect(selectActiveSource(useAppStore.getState())).toBeUndefined();
  });

  it("preserves a job completion that races with opening the target project", () => {
    useAppStore.getState().upsertSource("p2", source("p2", "late-result"));
    useAppStore.getState().addHistory("p2", { sql: "select 42", status: "success" });
    expect(useAppStore.getState().nextResultName("p2")).toBe("Result 1");
    const current = useAppStore.getState().projectWorkspaces.p2;
    const staleResponse = workspace(project("p2"));
    const merged = preserveWorkspaceMutations(staleResponse, current, useAppStore.getState().connectionsById);

    expect(merged.sources.map((item) => item.id)).toEqual(["late-result"]);
    expect(merged.session.history[0].sql).toBe("select 42");
    expect(merged.session.resultSequence).toBe(1);
  });

  it("keeps jobs global and filters them by project", () => {
    useAppStore.getState().upsertJob("p1", job("p1"));
    useAppStore.getState().upsertJob("p2", job("p2"));
    useAppStore.getState().upsertJob("p1", { ...job("p1"), state: "completed", progress: 1 });
    expect(useAppStore.getState().jobIds).toHaveLength(2);
    expect(selectProjectJobs(useAppStore.getState(), "p1")).toEqual([expect.objectContaining({ projectId: "p1", state: "completed" })]);
  });

  it("never stores preview rows and does not downgrade a ready source", () => {
    useAppStore.getState().upsertSource("p1", source("p1"));
    useAppStore.getState().upsertSource("p1", { ...source("p1"), status: "preparing", previewRows: [{ customer_id: 1 }] });
    const stored = useAppStore.getState().projectWorkspaces.p1.sourcesById["customers-id"];
    expect(stored.status).toBe("ready");
    expect(stored.previewRows).toBeUndefined();
    expect(JSON.stringify(useAppStore.getState())).not.toContain("customer_id\":1");
  });

  it("hydrates external placeholders without mixing local tabs", () => {
    useAppStore.getState().setGlobalConnections([connection]);
    useAppStore.getState().attachConnection("p1", connection.id);
    useAppStore.getState().upsertSource("p1", source("p1"));
    useAppStore.getState().openTab("p1", "customers-id");
    useAppStore.getState().openExternalTab("p1", relation);
    useAppStore.getState().markExternalPlaceholder("p1", relation.id, "disconnected");
    expect(useAppStore.getState().projectWorkspaces.p1.session.tabs.map((tab) => tab.kind)).toEqual(["local", "placeholder"]);
    useAppStore.getState().upsertExternalRelation("p1", relation);
    expect(useAppStore.getState().projectWorkspaces.p1.session.tabs.at(-1)?.kind).toBe("external");
  });

  it("attaches and removes a reusable connection only in the target project", () => {
    useAppStore.getState().setGlobalConnections([connection]);
    useAppStore.getState().attachConnection("p1", connection.id);
    useAppStore.getState().attachConnection("p2", connection.id);
    useAppStore.getState().detachConnection("p1", connection.id);
    expect(useAppStore.getState().projectWorkspaces.p1.connectionIds).toEqual([]);
    expect(useAppStore.getState().projectWorkspaces.p2.connectionIds).toEqual([connection.id]);
    expect(useAppStore.getState().connectionsById[connection.id]).toEqual(connection);
  });

  it("persists only lightweight panel layout", () => {
    useAppStore.getState().setGlobalConnections([connection]);
    useAppStore.getState().setDraft("p1", "select secret_value");
    useAppStore.getState().upsertSource("p1", source("p1"));
    useAppStore.getState().setPanel({ sqlCollapsed: true });
    const persisted = localStorage.getItem("ducs-table:layout:v2") ?? "";
    expect(persisted).toContain("sqlCollapsed");
    expect(persisted).not.toContain("db.internal");
    expect(persisted).not.toContain("select secret_value");
    expect(persisted).not.toContain("customers-id");
    expect(persisted.toLowerCase()).not.toContain("password");
  });
});
