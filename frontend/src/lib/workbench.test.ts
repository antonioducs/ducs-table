import { describe, expect, it } from "vitest";
import type { ProjectSession } from "@/types";
import {
  activeTabOf,
  closeTab,
  createSession,
  focusedDocumentId,
  groupTabs,
  listGroupIds,
  moveTab,
  neighborGroupId,
  normalizeSession,
  openOrSplitSQLTab,
  openSQLTab,
  openTab,
  resizeSplit,
  splitGroup,
  splitWithNewSQLTab,
  splitWithNewTab,
  updateDocument,
} from "./workbench";

function sessionWithTables(count: number): ProjectSession {
  let session = createSession();
  for (let index = 0; index < count; index += 1) {
    session = openTab(session, { kind: "local", title: `Table ${index}`, sourceId: `source-${index}` });
  }
  return session;
}

describe("workbench layout engine", () => {
  it("opens tabs in the active group and keeps a single group", () => {
    const session = sessionWithTables(2);
    expect(session.groups).toHaveLength(1);
    expect(groupTabs(session, session.groups[0].id).map((tab) => tab.title)).toEqual(["Table 0", "Table 1"]);
    expect(activeTabOf(session)?.title).toBe("Table 1");
  });

  it("reuses a tab pointing at the same resource", () => {
    let session = sessionWithTables(1);
    session = openTab(session, { kind: "local", title: "Table 0", sourceId: "source-0" }, {
      reuse: (tab) => tab.sourceId === "source-0",
    });
    expect(session.tabs).toHaveLength(1);
  });

  it("splits a group by handing over a tab and collapses it when emptied", () => {
    let session = sessionWithTables(2);
    const first = session.groups[0].id;
    session = splitGroup(session, first, "horizontal", session.tabs[1].id);

    expect(session.groups).toHaveLength(2);
    expect(session.layout.kind).toBe("split");
    expect(session.layout.direction).toBe("horizontal");
    expect(session.layout.children?.map((child) => child.size)).toEqual([50, 50]);
    expect(listGroupIds(session.layout)).toHaveLength(2);
    const created = session.groups[1];
    expect(created.tabIds).toHaveLength(1);
    expect(session.activeGroupId).toBe(created.id);

    session = closeTab(session, created.tabIds[0]);
    expect(session.groups).toHaveLength(1);
    expect(session.layout.kind).toBe("group");
    expect(session.layout.size).toBe(100);
  });

  it("duplicates a lone table tab when splitting", () => {
    let session = sessionWithTables(1);
    session = splitGroup(session, session.groups[0].id, "vertical");
    expect(session.groups).toHaveLength(2);
    expect(session.tabs).toHaveLength(2);
    expect(session.tabs[0].sourceId).toBe(session.tabs[1].sourceId);
    expect(session.tabs[0].id).not.toBe(session.tabs[1].id);
  });

  it("refuses to duplicate a lone SQL tab and offers a fresh query instead", () => {
    const base = openSQLTab(createSession(), { sql: "SELECT 1" }).session;
    expect(splitGroup(base, base.groups[0].id, "horizontal")).toBe(base);

    const { session } = splitWithNewSQLTab(base, base.groups[0].id, "horizontal");
    expect(session.groups).toHaveLength(2);
    expect(session.documents).toHaveLength(2);
    expect(session.documents[1].title).toBe("Query 2");
  });

  it("moves a tab between groups and keeps every tab assigned once", () => {
    let session = sessionWithTables(2);
    const first = session.groups[0].id;
    session = splitGroup(session, first, "horizontal", session.tabs[1].id);
    const second = session.groups[1].id;

    session = moveTab(session, session.tabs[0].id, second, 0);
    expect(session.groups).toHaveLength(1);
    expect(session.groups[0].id).toBe(second);
    expect(session.groups[0].tabIds).toHaveLength(2);
    expect(session.groups[0].tabIds[0]).toBe(session.tabs[0].id);
  });

  it("opens a new tab in a fresh split via splitWithNewTab", () => {
    let session = sessionWithTables(1);
    session = splitWithNewTab(session, session.groups[0].id, "vertical", { kind: "local", title: "Beside", sourceId: "source-beside" });
    expect(session.groups).toHaveLength(2);
    expect(session.layout.direction).toBe("vertical");
    expect(groupTabs(session, session.groups[1].id).map((tab) => tab.title)).toEqual(["Beside"]);
  });

  it("tracks the focused SQL document and its neighbor group", () => {
    let session = sessionWithTables(1);
    const opened = openSQLTab(session, { sql: "SELECT 1" });
    session = opened.session;
    expect(focusedDocumentId(session)).toBe(opened.documentId);

    session = updateDocument(session, opened.documentId, { sql: "SELECT 2", title: "Report" });
    expect(session.documents[0].sql).toBe("SELECT 2");
    expect(session.tabs.find((tab) => tab.kind === "sql")?.title).toBe("Report");

    session = splitGroup(session, session.groups[0].id, "horizontal", opened.tabId);
    const [left, right] = listGroupIds(session.layout);
    expect(neighborGroupId(session, left)).toBe(right);
    expect(neighborGroupId(session, right)).toBe(left);
  });

  it("drops the document when its SQL tab closes", () => {
    const opened = openSQLTab(createSession(), { sql: "SELECT 1" });
    const session = closeTab(opened.session, opened.tabId);
    expect(session.documents).toHaveLength(0);
    expect(session.tabs).toHaveLength(0);
    expect(session.groups).toHaveLength(1);
  });

  it("rescales split sizes on resize and keeps them summing to 100", () => {
    let session = sessionWithTables(2);
    session = splitGroup(session, session.groups[0].id, "horizontal", session.tabs[1].id);
    session = resizeSplit(session, [], [70.004, 29.996]);
    expect(session.layout.children?.map((child) => child.size)).toEqual([70, 30]);
  });

  it("puts the first query below the data instead of stacking it as a tab", () => {
    const session = sessionWithTables(1);
    const { session: withQuery, documentId } = openOrSplitSQLTab(session, { sql: "SELECT 1" });

    expect(withQuery.layout.kind).toBe("split");
    expect(withQuery.layout.direction).toBe("vertical");
    expect(withQuery.groups).toHaveLength(2);
    expect(groupTabs(withQuery, withQuery.groups[0].id).map((tab) => tab.kind)).toEqual(["local"]);
    expect(groupTabs(withQuery, withQuery.groups[1].id).map((tab) => tab.kind)).toEqual(["sql"]);
    expect(focusedDocumentId(withQuery)).toBe(documentId);

    // A second query joins the existing query group instead of splitting again.
    const { session: withSecond } = openOrSplitSQLTab(withQuery);
    expect(withSecond.groups).toHaveLength(2);
    expect(groupTabs(withSecond, withSecond.groups[1].id)).toHaveLength(2);
  });

  it("repairs a corrupt session instead of failing", () => {
    const broken = {
      version: 2,
      documents: [{ id: "doc-1", title: "Query 1", sql: "SELECT 1" }],
      tabs: [
        { id: "tab-1", kind: "sql", title: "Query 1", documentId: "doc-1" },
        { id: "tab-2", kind: "sql", title: "Ghost", documentId: "missing" },
      ],
      groups: [{ id: "group-a", tabIds: ["tab-1", "unknown"], activeTabId: "unknown" }],
      layout: { kind: "group", groupId: "gone" },
      activeGroupId: "gone",
      history: [],
      resultSequence: -3,
    } as unknown as ProjectSession;

    const session = normalizeSession(broken);
    expect(session.tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
    expect(session.groups[0].id).toBe("group-a");
    expect(session.groups[0].activeTabId).toBe("tab-1");
    expect(session.layout).toEqual({ kind: "group", groupId: "group-a", size: 100 });
    expect(session.activeGroupId).toBe("group-a");
    expect(session.resultSequence).toBe(0);
    expect(normalizeSession(session)).toEqual(session);
  });
});
