import type {
  ProjectLayoutNode,
  ProjectSession,
  ProjectTabGroup,
  ProjectTabReference,
  SQLDocument,
  SplitDirection,
} from "@/types";

export const SESSION_VERSION = 2;
export const MAX_GROUPS = 8;
/** Index path of child positions from the layout root; [] is the root itself. */
export type LayoutPath = number[];

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export const newGroupId = () => newId("group");
export const newTabId = () => newId("tab");
export const newDocumentId = () => newId("doc");

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Rescales siblings to sum to 100; idempotent so repeated saves do not churn. */
function normalizeSizes(children: ProjectLayoutNode[]): ProjectLayoutNode[] {
  const count = children.length;
  if (count === 0) return children;
  const sizes = children.map((child) => child.size ?? 0);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const positive = sizes.every((size) => Number.isFinite(size) && size > 0);
  const scaled: number[] = [];
  let accumulated = 0;
  for (let index = 0; index < count - 1; index += 1) {
    const value = positive ? round2((sizes[index] / total) * 100) : round2(100 / count);
    scaled.push(value);
    accumulated += value;
  }
  scaled.push(round2(100 - accumulated));
  return children.map((child, index) => child.size === scaled[index] ? child : { ...child, size: scaled[index] });
}

function groupLeaf(groupId: string, size?: number): ProjectLayoutNode {
  return { kind: "group", groupId, size };
}

export function createSession(): ProjectSession {
  const group: ProjectTabGroup = { id: newGroupId(), tabIds: [] };
  return {
    version: SESSION_VERSION,
    documents: [],
    tabs: [],
    groups: [group],
    layout: { kind: "group", groupId: group.id, size: 100 },
    activeGroupId: group.id,
    history: [],
    resultSequence: 0,
  };
}

function collectGroups(node: ProjectLayoutNode | undefined, seen: Set<string>, valid: Set<string>, depth = 0): ProjectLayoutNode | undefined {
  if (!node || depth > 6) return undefined;
  if (node.kind === "split") {
    const children = (node.children ?? [])
      .map((child) => collectGroups(child, seen, valid, depth + 1))
      .filter((child): child is ProjectLayoutNode => Boolean(child));
    if (children.length === 0) return undefined;
    if (children.length === 1) return { ...children[0], size: node.size };
    const direction: SplitDirection = node.direction === "vertical" ? "vertical" : "horizontal";
    return { kind: "split", direction, size: node.size, children: normalizeSizes(children) };
  }
  const groupId = node.groupId;
  if (!groupId || !valid.has(groupId) || seen.has(groupId)) return undefined;
  seen.add(groupId);
  return groupLeaf(groupId, node.size);
}

/**
 * Repairs structural invariants so the backend validator always accepts the
 * session: unique ids, every tab in exactly one group, one layout leaf per
 * group, and no empty group unless it is the last one.
 */
export function normalizeSession(input: ProjectSession): ProjectSession {
  const documents: SQLDocument[] = [];
  const documentIds = new Set<string>();
  for (const document of input.documents ?? []) {
    if (!document?.id || documentIds.has(document.id)) continue;
    documentIds.add(document.id);
    documents.push({ ...document, title: document.title?.trim() ? document.title : "Query" });
  }

  const tabs: ProjectTabReference[] = [];
  const tabIds = new Set<string>();
  const usedDocuments = new Set<string>();
  for (const tab of input.tabs ?? []) {
    if (!tab?.id || tabIds.has(tab.id)) continue;
    if (tab.kind === "sql") {
      if (!tab.documentId || !documentIds.has(tab.documentId) || usedDocuments.has(tab.documentId)) continue;
      usedDocuments.add(tab.documentId);
    }
    tabIds.add(tab.id);
    tabs.push(tab);
  }

  const groups: ProjectTabGroup[] = [];
  const groupIds = new Set<string>();
  const assigned = new Set<string>();
  for (const group of input.groups ?? []) {
    if (!group?.id || groupIds.has(group.id) || groups.length >= MAX_GROUPS) continue;
    groupIds.add(group.id);
    const ids = (group.tabIds ?? []).filter((tabId) => tabIds.has(tabId) && !assigned.has(tabId));
    for (const tabId of ids) assigned.add(tabId);
    groups.push({ ...group, tabIds: ids });
  }
  if (groups.length === 0) {
    const group: ProjectTabGroup = { id: newGroupId(), tabIds: [] };
    groups.push(group);
    groupIds.add(group.id);
  }
  for (const tab of tabs) {
    if (assigned.has(tab.id)) continue;
    groups[0].tabIds = [...groups[0].tabIds, tab.id];
    assigned.add(tab.id);
  }

  const populated = groups.filter((group) => group.tabIds.length > 0);
  const kept = populated.length > 0 ? populated : [{ ...groups[0], tabIds: [] }];
  const finalGroupIds = new Set(kept.map((group) => group.id));
  const finalGroups = kept.map((group) => {
    const activeTabId = group.activeTabId && group.tabIds.includes(group.activeTabId)
      ? group.activeTabId
      : group.tabIds[group.tabIds.length - 1];
    return { ...group, activeTabId };
  });

  const seen = new Set<string>();
  let layout = collectGroups(input.layout, seen, finalGroupIds) ?? groupLeaf(finalGroups[0].id);
  if (!seen.has(finalGroups[0].id) && layout.kind === "group" && layout.groupId === finalGroups[0].id) seen.add(finalGroups[0].id);
  for (const group of finalGroups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    if (layout.kind === "split") {
      layout = { ...layout, children: normalizeSizes([...(layout.children ?? []), groupLeaf(group.id)]) };
    } else {
      layout = { kind: "split", direction: "vertical", children: normalizeSizes([layout, groupLeaf(group.id)]) };
    }
  }
  layout = { ...layout, size: 100 };

  const documentsInUse = documents.filter((document) => usedDocuments.has(document.id));
  const activeGroupId = finalGroupIds.has(input.activeGroupId) ? input.activeGroupId : finalGroups[0].id;
  return {
    version: SESSION_VERSION,
    documents: documentsInUse,
    tabs,
    groups: finalGroups,
    layout,
    activeGroupId,
    history: (input.history ?? []).slice(0, 20),
    resultSequence: Number.isFinite(input.resultSequence) && input.resultSequence >= 0 ? Math.floor(input.resultSequence) : 0,
  };
}

export function listGroupIds(node: ProjectLayoutNode | undefined): string[] {
  if (!node) return [];
  if (node.kind === "split") return (node.children ?? []).flatMap(listGroupIds);
  return node.groupId ? [node.groupId] : [];
}

export function findTab(session: ProjectSession, tabId?: string): ProjectTabReference | undefined {
  return tabId ? session.tabs.find((tab) => tab.id === tabId) : undefined;
}

export function findGroup(session: ProjectSession, groupId?: string): ProjectTabGroup | undefined {
  return groupId ? session.groups.find((group) => group.id === groupId) : undefined;
}

export function groupOfTab(session: ProjectSession, tabId: string): ProjectTabGroup | undefined {
  return session.groups.find((group) => group.tabIds.includes(tabId));
}

export function activeGroup(session: ProjectSession): ProjectTabGroup {
  return findGroup(session, session.activeGroupId) ?? session.groups[0];
}

export function activeTabOf(session: ProjectSession, groupId?: string): ProjectTabReference | undefined {
  const group = groupId ? findGroup(session, groupId) : activeGroup(session);
  return findTab(session, group?.activeTabId);
}

export function activeTab(session: ProjectSession): ProjectTabReference | undefined {
  return activeTabOf(session);
}

export function groupTabs(session: ProjectSession, groupId: string): ProjectTabReference[] {
  const group = findGroup(session, groupId);
  if (!group) return [];
  return group.tabIds.map((tabId) => findTab(session, tabId)).filter((tab): tab is ProjectTabReference => Boolean(tab));
}

export function documentOf(session: ProjectSession, documentId?: string): SQLDocument | undefined {
  return documentId ? session.documents.find((document) => document.id === documentId) : undefined;
}

/**
 * The SQL document a "draft" action should target: the focused SQL tab, else a
 * SQL tab that is active in some other group, else the first SQL tab.
 */
export function focusedDocumentId(session: ProjectSession): string | undefined {
  const focused = activeTabOf(session);
  if (focused?.kind === "sql") return focused.documentId;
  for (const group of session.groups) {
    const tab = findTab(session, group.activeTabId);
    if (tab?.kind === "sql") return tab.documentId;
  }
  return session.tabs.find((tab) => tab.kind === "sql")?.documentId;
}

/** Group that should receive a new query: one already holding queries, else the neighbor. */
export function preferredSQLGroupId(session: ProjectSession): string | undefined {
  const holder = session.groups.find((group) => group.tabIds.some((tabId) => findTab(session, tabId)?.kind === "sql"));
  if (holder) return holder.id;
  const current = activeGroup(session);
  const focused = findTab(session, current.activeTabId);
  if (!focused || focused.kind === "sql") return current.id;
  return neighborGroupId(session, current.id) ?? current.id;
}

/** Group displayed next to `groupId`, used to open results beside a query. */
export function neighborGroupId(session: ProjectSession, groupId: string): string | undefined {
  const ordered = listGroupIds(session.layout);
  const index = ordered.indexOf(groupId);
  if (index < 0) return undefined;
  return ordered[index + 1] ?? ordered[index - 1];
}

export interface OpenTabOptions {
  groupId?: string;
  activate?: boolean;
  /** Reuse an existing tab pointing at the same resource before creating one. */
  reuse?: (tab: ProjectTabReference) => boolean;
}

export function openTab(session: ProjectSession, tab: Omit<ProjectTabReference, "id"> & { id?: string }, options: OpenTabOptions = {}): ProjectSession {
  const targetGroupId = options.groupId && findGroup(session, options.groupId) ? options.groupId : activeGroup(session).id;
  const activate = options.activate !== false;

  if (options.reuse) {
    const existing = session.tabs.find(options.reuse);
    if (existing) {
      const merged = { ...existing, ...tab, id: existing.id };
      const owner = groupOfTab(session, existing.id);
      const next: ProjectSession = {
        ...session,
        tabs: session.tabs.map((item) => item.id === existing.id ? merged : item),
        groups: session.groups.map((group) => group.id === owner?.id && activate ? { ...group, activeTabId: existing.id } : group),
        activeGroupId: activate && owner ? owner.id : session.activeGroupId,
      };
      return normalizeSession(next);
    }
  }

  const id = tab.id ?? newTabId();
  const created: ProjectTabReference = { ...tab, id };
  const next: ProjectSession = {
    ...session,
    tabs: [...session.tabs, created],
    groups: session.groups.map((group) => group.id === targetGroupId
      ? { ...group, tabIds: [...group.tabIds, id], activeTabId: activate ? id : group.activeTabId }
      : group),
    activeGroupId: activate ? targetGroupId : session.activeGroupId,
  };
  return normalizeSession(next);
}

export interface OpenSQLTabOptions extends OpenTabOptions {
  title?: string;
  sql?: string;
  savedQueryId?: string;
}

interface StagedSQLTab {
  session: ProjectSession;
  documentId: string;
  tabId: string;
  tab: Omit<ProjectTabReference, "id"> & { id: string };
}

function stageSQLDocument(session: ProjectSession, options: OpenSQLTabOptions): StagedSQLTab {
  const documentId = newDocumentId();
  const tabId = newTabId();
  const title = options.title?.trim() || nextQueryTitle(session);
  const document: SQLDocument = {
    id: documentId,
    title,
    sql: options.sql ?? "",
    savedQueryId: options.savedQueryId,
    updatedAt: new Date().toISOString(),
  };
  return {
    session: { ...session, documents: [...session.documents, document] },
    documentId,
    tabId,
    tab: { kind: "sql", title, documentId, id: tabId },
  };
}

export function openSQLTab(session: ProjectSession, options: OpenSQLTabOptions = {}): { session: ProjectSession; documentId: string; tabId: string } {
  const staged = stageSQLDocument(session, options);
  return { session: openTab(staged.session, staged.tab, options), documentId: staged.documentId, tabId: staged.tabId };
}

/**
 * Opens a query where a user expects it: in the group that already holds
 * queries, or — on a workbench that only shows data — in a new split below, so
 * the familiar "table on top, SQL underneath" reading order is preserved.
 */
export function openOrSplitSQLTab(session: ProjectSession, options: OpenSQLTabOptions = {}): { session: ProjectSession; documentId: string; tabId: string } {
  if (options.groupId && findGroup(session, options.groupId)) return openSQLTab(session, options);
  const holder = session.groups.find((group) => group.tabIds.some((tabId) => findTab(session, tabId)?.kind === "sql"));
  if (holder) return openSQLTab(session, { ...options, groupId: holder.id });
  const current = activeGroup(session);
  if (current.tabIds.length === 0 || session.groups.length >= MAX_GROUPS) {
    return openSQLTab(session, { ...options, groupId: current.id });
  }
  return splitWithNewSQLTab(session, current.id, "vertical", options);
}

export function nextQueryTitle(session: ProjectSession): string {
  const used = new Set(session.documents.map((document) => document.title));
  for (let index = 1; index <= used.size + 1; index += 1) {
    const candidate = `Query ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `Query ${used.size + 1}`;
}

export function updateDocument(session: ProjectSession, documentId: string, patch: Partial<Omit<SQLDocument, "id">>): ProjectSession {
  if (!documentOf(session, documentId)) return session;
  const documents = session.documents.map((document) => document.id === documentId
    ? { ...document, ...patch, updatedAt: new Date().toISOString() }
    : document);
  const tabs = patch.title
    ? session.tabs.map((tab) => tab.documentId === documentId ? { ...tab, title: patch.title! } : tab)
    : session.tabs;
  return { ...session, documents, tabs };
}

export function closeTab(session: ProjectSession, tabId: string): ProjectSession {
  if (!findTab(session, tabId)) return session;
  const owner = groupOfTab(session, tabId);
  const groups = session.groups.map((group) => {
    if (group.id !== owner?.id) return group;
    const index = group.tabIds.indexOf(tabId);
    const tabIds = group.tabIds.filter((id) => id !== tabId);
    const activeTabId = group.activeTabId === tabId
      ? tabIds[Math.min(Math.max(index - 1, 0), Math.max(tabIds.length - 1, 0))]
      : group.activeTabId;
    return { ...group, tabIds, activeTabId };
  });
  return normalizeSession({ ...session, tabs: session.tabs.filter((tab) => tab.id !== tabId), groups });
}

export function closeTabs(session: ProjectSession, predicate: (tab: ProjectTabReference) => boolean): ProjectSession {
  const removed = session.tabs.filter(predicate).map((tab) => tab.id);
  return removed.reduce((current, tabId) => closeTab(current, tabId), session);
}

export function selectTab(session: ProjectSession, tabId: string): ProjectSession {
  const owner = groupOfTab(session, tabId);
  if (!owner) return session;
  return {
    ...session,
    groups: session.groups.map((group) => group.id === owner.id ? { ...group, activeTabId: tabId } : group),
    activeGroupId: owner.id,
  };
}

export function focusGroup(session: ProjectSession, groupId: string): ProjectSession {
  if (!findGroup(session, groupId) || session.activeGroupId === groupId) return session;
  return { ...session, activeGroupId: groupId };
}

export function moveTab(session: ProjectSession, tabId: string, targetGroupId: string, index?: number): ProjectSession {
  const tab = findTab(session, tabId);
  const target = findGroup(session, targetGroupId);
  if (!tab || !target) return session;
  const groups = session.groups.map((group) => {
    const withoutTab = group.tabIds.filter((id) => id !== tabId);
    if (group.id !== targetGroupId) {
      if (withoutTab.length === group.tabIds.length) return group;
      const activeTabId = group.activeTabId === tabId ? withoutTab[withoutTab.length - 1] : group.activeTabId;
      return { ...group, tabIds: withoutTab, activeTabId };
    }
    const position = index === undefined ? withoutTab.length : Math.max(0, Math.min(index, withoutTab.length));
    const tabIds = [...withoutTab.slice(0, position), tabId, ...withoutTab.slice(position)];
    return { ...group, tabIds, activeTabId: tabId };
  });
  return normalizeSession({ ...session, groups, activeGroupId: targetGroupId });
}

function replaceLeaf(node: ProjectLayoutNode, groupId: string, replacement: ProjectLayoutNode): ProjectLayoutNode {
  if (node.kind === "group") return node.groupId === groupId ? { ...replacement, size: node.size } : node;
  return { ...node, children: (node.children ?? []).map((child) => replaceLeaf(child, groupId, replacement)) };
}

/**
 * Splits `groupId` in `direction`. A group with several tabs hands one over; a
 * group with a single non-SQL tab duplicates it, mirroring VS Code. A lone SQL
 * tab cannot be duplicated (a document belongs to one tab), so callers should
 * fall back to `splitWithNewTab` for a fresh query.
 */
export function splitGroup(session: ProjectSession, groupId: string, direction: SplitDirection, tabId?: string): ProjectSession {
  const source = findGroup(session, groupId);
  if (!source || session.groups.length >= MAX_GROUPS) return session;
  const movedTabId = tabId ?? source.activeTabId;
  const moved = findTab(session, movedTabId);
  if (!moved) return session;
  const duplicating = source.tabIds.length < 2;
  if (duplicating && moved.kind === "sql") return session;

  const createdId = newGroupId();
  const layout = replaceLeaf(session.layout, groupId, {
    kind: "split",
    direction,
    children: normalizeSizes([groupLeaf(groupId, 50), groupLeaf(createdId, 50)]),
  });

  if (duplicating) {
    const copy: ProjectTabReference = { ...moved, id: newTabId() };
    return normalizeSession({
      ...session,
      layout,
      tabs: [...session.tabs, copy],
      groups: [...session.groups, { id: createdId, tabIds: [copy.id], activeTabId: copy.id }],
      activeGroupId: createdId,
    });
  }

  const groups = session.groups.map((group) => {
    if (group.id !== groupId) return group;
    const tabIds = group.tabIds.filter((id) => id !== moved.id);
    const activeTabId = group.activeTabId === moved.id ? tabIds[tabIds.length - 1] : group.activeTabId;
    return { ...group, tabIds, activeTabId };
  });
  return normalizeSession({
    ...session,
    layout,
    groups: [...groups, { id: createdId, tabIds: [moved.id], activeTabId: moved.id }],
    activeGroupId: createdId,
  });
}

/** Splits by opening `tab` in a brand-new group instead of moving an existing one. */
export function splitWithNewTab(
  session: ProjectSession,
  groupId: string,
  direction: SplitDirection,
  tab: Omit<ProjectTabReference, "id"> & { id?: string },
): ProjectSession {
  const source = findGroup(session, groupId);
  if (!source || session.groups.length >= MAX_GROUPS) return openTab(session, tab, { groupId });
  const created: ProjectTabGroup = { id: newGroupId(), tabIds: [] };
  const split: ProjectLayoutNode = {
    kind: "split",
    direction,
    children: normalizeSizes([groupLeaf(groupId, 50), groupLeaf(created.id, 50)]),
  };
  const staged: ProjectSession = {
    ...session,
    groups: [...session.groups, created],
    layout: replaceLeaf(session.layout, groupId, split),
    activeGroupId: created.id,
  };
  return openTab(staged, tab, { groupId: created.id });
}

/** Splits a group by starting a brand-new query beside it. */
export function splitWithNewSQLTab(
  session: ProjectSession,
  groupId: string,
  direction: SplitDirection,
  options: OpenSQLTabOptions = {},
): { session: ProjectSession; documentId: string; tabId: string } {
  const staged = stageSQLDocument(session, options);
  return {
    session: splitWithNewTab(staged.session, groupId, direction, staged.tab),
    documentId: staged.documentId,
    tabId: staged.tabId,
  };
}

export function collapseEmptyGroups(session: ProjectSession): ProjectSession {
  return normalizeSession(session);
}

function nodeAt(node: ProjectLayoutNode, path: LayoutPath): ProjectLayoutNode | undefined {
  return path.reduce<ProjectLayoutNode | undefined>((current, index) => current?.children?.[index], node);
}

export function resizeSplit(session: ProjectSession, path: LayoutPath, sizes: number[]): ProjectSession {
  const target = nodeAt(session.layout, path);
  if (!target || target.kind !== "split" || (target.children ?? []).length !== sizes.length) return session;

  const apply = (node: ProjectLayoutNode, remaining: LayoutPath): ProjectLayoutNode => {
    if (remaining.length === 0) {
      const children = (node.children ?? []).map((child, index) => ({ ...child, size: sizes[index] }));
      return { ...node, children: normalizeSizes(children) };
    }
    const [head, ...rest] = remaining;
    return {
      ...node,
      children: (node.children ?? []).map((child, index) => index === head ? apply(child, rest) : child),
    };
  };
  return { ...session, layout: apply(session.layout, path) };
}
