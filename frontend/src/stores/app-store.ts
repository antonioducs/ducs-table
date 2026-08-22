import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { BootstrapState, Job, SavedQuery, SourceInfo } from "@/types";

export interface AppTab {
  id: string;
  sourceId: string;
  title: string;
  kind: "dataset" | "result";
}

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  ranAt: string;
  durationMs?: number;
  status: "success" | "error";
}

export interface PanelState {
  sidebarSize: number;
  sqlSize: number;
  sqlCollapsed: boolean;
}

interface PersistedPreferences {
  lastActiveSourceId?: string;
  panel: PanelState;
}

export interface AppState {
  sources: SourceInfo[];
  tabs: AppTab[];
  activeTabId?: string;
  sqlDrafts: Record<string, string>;
  activeSavedQueryId?: string;
  history: QueryHistoryEntry[];
  savedQueries: SavedQuery[];
  jobs: Job[];
  panel: PanelState;
  preferences: PersistedPreferences;
  bootstrapped: boolean;
  resultSequence: number;
  bootstrap: (state: BootstrapState) => void;
  upsertSource: (source: SourceInfo) => void;
  removeSource: (sourceId: string) => void;
  upsertJob: (job: Job) => void;
  openTab: (sourceId: string) => void;
  closeTab: (tabId: string) => void;
  selectTab: (tabId: string) => void;
  selectSource: (sourceId: string) => void;
  setDraft: (key: string, sql: string) => void;
  insertIntoDraft: (key: string, text: string) => void;
  newDraft: (key: string) => void;
  loadSavedQuery: (queryId: string, draftKey: string) => void;
  upsertSavedQuery: (query: SavedQuery) => void;
  removeSavedQuery: (queryId: string) => void;
  addHistory: (entry: Omit<QueryHistoryEntry, "id" | "ranAt">) => void;
  setPanel: (patch: Partial<PanelState>) => void;
  nextResultName: () => string;
  reset: () => void;
}

const initialPanel: PanelState = { sidebarSize: 19, sqlSize: 29, sqlCollapsed: false };

function tabFor(source: SourceInfo): AppTab {
  return {
    id: `source:${source.id}`,
    sourceId: source.id,
    title: source.displayName,
    kind: source.isEphemeral ? "result" : "dataset",
  };
}

const dataInitial = {
  sources: [] as SourceInfo[],
  tabs: [] as AppTab[],
  activeTabId: undefined as string | undefined,
  sqlDrafts: {} as Record<string, string>,
  activeSavedQueryId: undefined as string | undefined,
  history: [] as QueryHistoryEntry[],
  savedQueries: [] as SavedQuery[],
  jobs: [] as Job[],
  panel: initialPanel,
  preferences: { panel: initialPanel } as PersistedPreferences,
  bootstrapped: false,
  resultSequence: 0,
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...dataInitial,
      bootstrap: (state) => set((current) => {
        const sources = state.sources ?? [];
        const existingIds = new Set(sources.map((source) => source.id));
        const tabs = current.tabs
          .filter((tab) => existingIds.has(tab.sourceId))
          .map((tab) => ({ ...tab, ...tabFor(sources.find((source) => source.id === tab.sourceId)!) }));
        const preferred = current.preferences.lastActiveSourceId;
        const preferredSource = preferred && sources.find((source) => source.id === preferred);
        if (preferredSource && !tabs.some((tab) => tab.sourceId === preferredSource.id)) tabs.push(tabFor(preferredSource));
        const activeTabId = tabs.some((tab) => tab.id === current.activeTabId)
          ? current.activeTabId
          : preferredSource
            ? `source:${preferredSource.id}`
            : tabs[0]?.id;
        return {
          sources,
          savedQueries: state.savedQueries ?? [],
          jobs: state.jobs ?? [],
          tabs,
          activeTabId,
          bootstrapped: true,
        };
      }),
      upsertSource: (source) => set((current) => {
        const index = current.sources.findIndex((item) => item.id === source.id);
        const sources = [...current.sources];
        if (index >= 0) {
          const existing = sources[index];
          sources[index] = existing.status === "ready" && (source.status === "preview" || source.status === "preparing")
            ? existing
            : { ...existing, ...source };
        }
        else sources.push(source);
        const tabs = current.tabs.map((tab) => tab.sourceId === source.id ? tabFor(source) : tab);
        return { sources, tabs };
      }),
      removeSource: (sourceId) => set((current) => {
        const removedTabIds = new Set(current.tabs.filter((tab) => tab.sourceId === sourceId).map((tab) => tab.id));
        const tabs = current.tabs.filter((tab) => tab.sourceId !== sourceId);
        return {
          sources: current.sources.filter((source) => source.id !== sourceId),
          tabs,
          activeTabId: current.activeTabId && removedTabIds.has(current.activeTabId)
            ? tabs.at(-1)?.id
            : current.activeTabId,
        };
      }),
      upsertJob: (job) => set((current) => {
        const index = current.jobs.findIndex((item) => item.id === job.id);
        const jobs = [...current.jobs];
        if (index >= 0) jobs[index] = { ...jobs[index], ...job };
        else jobs.unshift(job);
        return { jobs };
      }),
      openTab: (sourceId) => set((current) => {
        const source = current.sources.find((item) => item.id === sourceId);
        if (!source) return current;
        const tab = tabFor(source);
        const tabs = current.tabs.some((item) => item.id === tab.id) ? current.tabs : [...current.tabs, tab];
        return {
          tabs,
          activeTabId: tab.id,
          preferences: { ...current.preferences, lastActiveSourceId: sourceId },
        };
      }),
      closeTab: (tabId) => set((current) => {
        const index = current.tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) return current;
        const tabs = current.tabs.filter((tab) => tab.id !== tabId);
        const activeTabId = current.activeTabId === tabId
          ? tabs[Math.min(index, tabs.length - 1)]?.id
          : current.activeTabId;
        const activeSource = tabs.find((tab) => tab.id === activeTabId)?.sourceId;
        return {
          tabs,
          activeTabId,
          preferences: { ...current.preferences, lastActiveSourceId: activeSource },
        };
      }),
      selectTab: (tabId) => set((current) => {
        const tab = current.tabs.find((item) => item.id === tabId);
        if (!tab) return current;
        return {
          activeTabId: tabId,
          preferences: { ...current.preferences, lastActiveSourceId: tab.sourceId },
        };
      }),
      selectSource: (sourceId) => get().openTab(sourceId),
      setDraft: (key, sql) => set((current) => ({ sqlDrafts: { ...current.sqlDrafts, [key]: sql } })),
      insertIntoDraft: (key, text) => set((current) => {
        const existing = current.sqlDrafts[key] ?? "";
        const separator = existing && !/\s$/.test(existing) ? " " : "";
        return { sqlDrafts: { ...current.sqlDrafts, [key]: `${existing}${separator}${text}` } };
      }),
      newDraft: (key) => set((current) => ({
        sqlDrafts: { ...current.sqlDrafts, [key]: "" },
        activeSavedQueryId: undefined,
      })),
      loadSavedQuery: (queryId, draftKey) => set((current) => {
        const query = current.savedQueries.find((item) => item.id === queryId);
        if (!query) return current;
        return {
          sqlDrafts: { ...current.sqlDrafts, [draftKey]: query.sql },
          activeSavedQueryId: query.id,
          panel: { ...current.panel, sqlCollapsed: false },
        };
      }),
      upsertSavedQuery: (query) => set((current) => {
        const exists = current.savedQueries.some((item) => item.id === query.id);
        return {
          savedQueries: exists
            ? current.savedQueries.map((item) => item.id === query.id ? query : item)
            : [...current.savedQueries, query].sort((a, b) => a.name.localeCompare(b.name)),
          activeSavedQueryId: query.id,
        };
      }),
      removeSavedQuery: (queryId) => set((current) => ({
        savedQueries: current.savedQueries.filter((query) => query.id !== queryId),
        activeSavedQueryId: current.activeSavedQueryId === queryId ? undefined : current.activeSavedQueryId,
      })),
      addHistory: (entry) => set((current) => ({
        history: [
          { ...entry, id: crypto.randomUUID(), ranAt: new Date().toISOString() },
          ...current.history,
        ].slice(0, 20),
      })),
      setPanel: (patch) => set((current) => {
        const panel = { ...current.panel, ...patch };
        return { panel, preferences: { ...current.preferences, panel } };
      }),
      nextResultName: () => {
        const next = get().resultSequence + 1;
        set({ resultSequence: next });
        return `Result ${next}`;
      },
      reset: () => set({ ...dataInitial, panel: initialPanel, preferences: { panel: initialPanel } }),
    }),
    {
      name: "ducs-table:preferences:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ preferences: state.preferences }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<AppState>;
        const preferences = saved.preferences ?? current.preferences;
        return { ...current, preferences, panel: preferences.panel ?? current.panel };
      },
    },
  ),
);

export const selectActiveSource = (state: AppState): SourceInfo | undefined => {
  const sourceId = state.tabs.find((tab) => tab.id === state.activeTabId)?.sourceId;
  return state.sources.find((source) => source.id === sourceId);
};

export const selectActiveJobs = (state: AppState): Job[] =>
  state.jobs.filter((job) => job.state === "queued" || job.state === "running");
