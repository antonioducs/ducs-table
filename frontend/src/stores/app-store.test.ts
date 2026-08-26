import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyProjectSession, preserveWorkspaceMutations, selectActiveSource, selectProjectJobs, useAppStore } from "./app-store";
import { focusedDocumentId } from "@/lib/workbench";
import type { ConnectionInfo, ExternalRelationInfo, Job, Project, ProjectWorkspace, SavedQuery, SourceInfo } from "@/types";

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
  session: createEmptyProjectSession(),
});

const draftOf = (projectId: string): string | undefined => {
  const session = useAppStore.getState().projectWorkspaces[projectId]?.session;
  return session ? session.documents.find((document) => document.id === focusedDocumentId(session))?.sql : undefined;
};

const activeTabIdOf = (projectId: string): string | undefined => {
  const session = useAppStore.getState().projectWorkspaces[projectId]?.session;
  return session?.groups.find((group) => group.id === session.activeGroupId)?.activeTabId;
};

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
    expect(draftOf("p1")).toBe("select 1");
    expect(draftOf("p2")).toBe("select 2");
    expect(current.projectWorkspaces.p1.session.tabs[0].kind).toBe("local");
    expect(current.projectWorkspaces.p2.session.tabs.map((tab) => tab.kind)).toEqual(["sql"]);
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

  it("keeps an open saved-query tab in sync when the query is renamed", () => {
    const saved: SavedQuery = { projectId: "p1", id: "saved-1", name: "Old name", sql: "select 42" };
    useAppStore.getState().upsertSavedQuery("p1", saved);
    useAppStore.getState().loadSavedQuery("p1", saved.id);

    useAppStore.getState().upsertSavedQuery("p1", { ...saved, name: "New name" });

    const current = useAppStore.getState().projectWorkspaces.p1;
    const document = current.session.documents.find((item) => item.savedQueryId === saved.id);
    const tab = current.session.tabs.find((item) => item.documentId === document?.id);
    expect(current.savedQueriesById[saved.id].name).toBe("New name");
    expect(document).toMatchObject({ title: "New name", sql: "select 42" });
    expect(tab?.title).toBe("New name");
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
    // Background projects still park the tab, but nothing in p1 becomes active.
    expect(activeTabIdOf("p1")).toBeUndefined();
    expect(useAppStore.getState().projectWorkspaces.p2.session.tabs).toHaveLength(1);
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
    useAppStore.getState().upsertSource("p1", { ...source("p1"), status: "cancelled" });
    const stored = useAppStore.getState().projectWorkspaces.p1.sourcesById["customers-id"];
    expect(stored.status).toBe("ready");
    expect(stored.previewRows).toBeUndefined();
    expect(JSON.stringify(useAppStore.getState())).not.toContain("customer_id\":1");
  });

  it("does not let a stale preview overwrite failed or cancelled import state", () => {
    const preparing = { ...source("p1", "racing-import"), status: "preparing" as const, rowCount: null };
    useAppStore.getState().upsertSource("p1", { ...preparing, status: "failed", error: { message: "Import failed" } });
    useAppStore.getState().upsertSource("p1", preparing);
    expect(useAppStore.getState().projectWorkspaces.p1.sourcesById["racing-import"].status).toBe("failed");

    useAppStore.getState().upsertSource("p1", { ...preparing, id: "cancelled-import", status: "cancelled" });
    useAppStore.getState().upsertSource("p1", { ...preparing, id: "cancelled-import" });
    expect(useAppStore.getState().projectWorkspaces.p1.sourcesById["cancelled-import"].status).toBe("cancelled");
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
    useAppStore.getState().setPanel({ sidebarCollapsed: true, aiCollapsed: false, aiSize: 31 });
    const persisted = localStorage.getItem("ducs-table:layout:v2") ?? "";
    expect(persisted).toContain("sidebarCollapsed");
    expect(persisted).toContain("aiSize");
    // The workbench layout now lives in the per-project session, not localStorage.
    expect(persisted).not.toContain("layout");
    expect(persisted).not.toContain("db.internal");
    expect(persisted).not.toContain("select secret_value");
    expect(persisted).not.toContain("customers-id");
    expect(persisted.toLowerCase()).not.toContain("password");
  });
});
