import { useCallback, useEffect, useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ChevronUp, Code2, Copy, Save, Trash2 } from "lucide-react";
import { Toaster, toast } from "sonner";
import { bridge, getErrorMessage, normalizeSource } from "@/lib/bridge";
import { quoteIdentifier } from "@/lib/utils";
import type {
  ImportOptions,
  ImportPathsResult,
  ImportStartResult,
  Job,
  SourceInfo,
  WorkbookSheets,
} from "@/types";
import { selectActiveSource, useAppStore } from "@/stores/app-store";
import DataGrid, { type GridViewState } from "@/components/data-grid/DataGrid";
import SQLPanel from "@/components/sql-editor/SQLPanel";
import { TopBar } from "@/components/layout/TopBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { TabsBar } from "@/components/layout/TabsBar";
import { StatusBar } from "@/components/layout/StatusBar";
import { EmptyState } from "@/components/import/EmptyState";
import { ImportStatusBanner } from "@/components/import/ImportStatusBanner";
import { RetryImportDialog, SheetPicker } from "@/components/import/ImportDialogs";
import { JobsPanel } from "@/components/jobs/JobsPanel";
import { ConfirmDialog, ExportDialog, NameDialog } from "@/components/layout/ActionDialogs";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

type PendingDelete = { kind: "dataset" | "result" | "query"; id: string; name: string };

const emptyView: GridViewState = { sorts: [], filters: [], visibleColumns: [] };

export default function App() {
  const store = useAppStore();
  const activeSource = selectActiveSource(store);
  const activeSourceId = activeSource?.id;
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [dragActive, setDragActive] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [workbooks, setWorkbooks] = useState<WorkbookSheets[]>([]);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [retrySource, setRetrySource] = useState<SourceInfo>();
  const [retryBusy, setRetryBusy] = useState(false);
  const [gridViews, setGridViews] = useState<Record<string, GridViewState>>({});
  const [queryRunning, setQueryRunning] = useState(false);
  const [queryError, setQueryError] = useState<string>();
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  const [saveQueryBusy, setSaveQueryBusy] = useState(false);
  const [saveResultOpen, setSaveResultOpen] = useState(false);
  const [saveResultBusy, setSaveResultBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>();

  const draftKey = "workspace";
  const sqlText = store.sqlDrafts[draftKey] ?? "";
  const readySources = useMemo(() => store.sources.filter((source) => source.status === "ready"), [store.sources]);
  const activeJobs = useMemo(() => store.jobs.filter((job) => job.state === "queued" || job.state === "running"), [store.jobs]);
  const activeJob = activeSource ? store.jobs.find((job) => job.sourceId === activeSource.id && (job.state === "queued" || job.state === "running")) : undefined;
  const activeSavedQuery = store.savedQueries.find((query) => query.id === store.activeSavedQueryId);

  const handleBatch = useCallback((batch: ImportPathsResult | ImportStartResult) => {
    const actions = useAppStore.getState();
    for (const source of batch.sources ?? []) {
      const normalized = normalizeSource(source);
      actions.upsertSource(normalized);
      actions.openTab(normalized.id);
      if (normalized.status === "failed") toast.error(normalized.error?.message ?? `Could not import ${normalized.displayName}`);
    }
    for (const job of batch.jobs ?? []) actions.upsertJob(job);
    if ("workbooks" in batch && batch.workbooks?.length) setWorkbooks((current) => [...current, ...batch.workbooks!]);
  }, []);

  const importPaths = useCallback(async (paths: string[], options?: ImportOptions) => {
    if (!paths.length) return;
    try {
      handleBatch(await bridge.ImportPaths({ paths, options }));
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }, [handleBatch]);

  const openFiles = useCallback(async () => {
    try {
      const result = await bridge.OpenFiles();
      if (!result) return;
      if (Array.isArray(result)) await importPaths(result);
      else handleBatch(result);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }, [handleBatch, importPaths]);

  useEffect(() => {
    let alive = true;
    void bridge.Bootstrap().then((state) => {
      if (alive) useAppStore.getState().bootstrap(state);
    }).catch((error) => {
      if (alive) {
        setBootstrapError(getErrorMessage(error));
        useAppStore.getState().bootstrap({ sources: [], savedQueries: [], jobs: [], ready: false });
      }
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const unsubscribers = [
      bridge.on("ducs:job-updated", (job) => {
        const actions = useAppStore.getState();
        actions.upsertJob(job);
        if (job.sourceId && job.state === "cancelled") {
          const source = actions.sources.find((item) => item.id === job.sourceId);
          if (source) actions.upsertSource({ ...source, status: "cancelled" });
        }
      }),
      bridge.on("ducs:dataset-preview", (payload) => {
        const actions = useAppStore.getState();
        const raw = "source" in payload ? payload.source : payload;
        const source = normalizeSource(raw);
        actions.upsertSource(source);
        actions.openTab(source.id);
      }),
      bridge.on("ducs:dataset-ready", (payload) => {
        const actions = useAppStore.getState();
        const raw = "source" in payload ? payload.source : payload;
        const source = { ...normalizeSource(raw), status: "ready" as const, previewRows: undefined };
        actions.upsertSource(source);
        toast.success(`${source.displayName} is ready`, { description: `${source.rowCount?.toLocaleString() ?? "0"} rows · ${source.tableName}` });
      }),
      bridge.on("ducs:dataset-failed", (payload) => {
        const actions = useAppStore.getState();
        const current = actions.sources.find((source) => source.id === payload.sourceId);
        if (!current) return;
        const cancelled = payload.error?.code === "CANCELLED" || payload.error?.code === "JOB_CANCELLED";
        actions.upsertSource({ ...current, status: cancelled ? "cancelled" : "failed", error: payload.error });
        if (!cancelled) toast.error(payload.error.message);
      }),
      bridge.on("ducs:result-ready", (payload) => {
        const actions = useAppStore.getState();
        const raw = "source" in payload ? payload.source : payload;
        const source = { ...normalizeSource(raw), status: "ready" as const };
        if (!actions.sources.some((item) => item.id === source.id)) actions.upsertSource(source);
      }),
      bridge.on("ducs:file-drop", (payload) => {
        const paths = Array.isArray(payload) ? payload : payload.paths;
        void importPaths(paths);
        setDragActive(false);
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [importPaths]);

  useEffect(() => {
    const enter = (event: DragEvent) => { event.preventDefault(); setDragActive(true); };
    const over = (event: DragEvent) => event.preventDefault();
    const leave = (event: DragEvent) => { if (!event.relatedTarget) setDragActive(false); };
    const drop = (event: DragEvent) => { event.preventDefault(); setDragActive(false); };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  }, []);

  const runQuery = async () => {
    if (!sqlText.trim() || queryRunning) return;
    setQueryRunning(true);
    setQueryError(undefined);
    const started = performance.now();
    try {
      const result = await bridge.RunQuery({ sql: sqlText });
      const source = { ...normalizeSource(result.source), displayName: store.nextResultName(), status: "ready" as const };
      store.upsertSource(source);
      store.openTab(source.id);
      store.addHistory({ sql: sqlText, status: "success", durationMs: result.durationMs ?? Math.round(performance.now() - started) });
      toast.success(`${source.displayName} created`, { description: `${result.rowCount ?? source.rowCount ?? 0} rows in ${result.durationMs ?? Math.round(performance.now() - started)}ms` });
    } catch (error) {
      const message = getErrorMessage(error);
      setQueryError(message);
      store.addHistory({ sql: sqlText, status: "error", durationMs: Math.round(performance.now() - started) });
      toast.error("Query failed", { description: message });
    } finally {
      setQueryRunning(false);
    }
  };

  const saveQuery = async (name: string) => {
    setSaveQueryBusy(true);
    try {
      const saved = await bridge.SaveQuery({ id: activeSavedQuery?.id, name, sql: sqlText });
      store.upsertSavedQuery(saved);
      setSaveQueryOpen(false);
      toast.success(`Saved query “${saved.name}”`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaveQueryBusy(false);
    }
  };

  const saveResult = async (name: string) => {
    if (!activeSource?.isEphemeral) return;
    setSaveResultBusy(true);
    try {
      const saved = normalizeSource(await bridge.SaveResultAsTable({ resultId: activeSource.id, displayName: name }));
      store.upsertSource({ ...saved, status: "ready" });
      setSaveResultOpen(false);
      toast.success(`Saved as ${saved.tableName}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaveResultBusy(false);
    }
  };

  const exportCSV = async (scope: "entire" | "current-view") => {
    if (!activeSource) return;
    const view = gridViews[activeSource.id] ?? { ...emptyView, visibleColumns: activeSource.columns.map((column) => column.name) };
    if (scope === "current-view" && view.visibleColumns.length === 0) {
      toast.error("Show at least one column before exporting the current view.");
      return;
    }
    setExportBusy(true);
    try {
      const result = await bridge.ExportCSV({
        sourceId: activeSource.id,
        scope,
        filters: scope === "current-view" ? view.filters : undefined,
        sorts: scope === "current-view" ? view.sorts : undefined,
        visibleColumns: scope === "current-view" ? view.visibleColumns : undefined,
      });
      setExportOpen(false);
      toast.success("CSV exported", { description: result.path });
    } catch (error) {
      const message = getErrorMessage(error);
      if (!/cancel/i.test(message)) toast.error("Export failed", { description: message });
    } finally {
      setExportBusy(false);
    }
  };

  const cancelJob = async (job: Job) => {
    try {
      store.upsertJob(await bridge.CancelJob(job.id));
      const source = job.sourceId && store.sources.find((item) => item.id === job.sourceId);
      if (source) store.upsertSource({ ...source, status: "cancelled" });
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const closeTab = (tabId: string) => {
    const tab = store.tabs.find((item) => item.id === tabId);
    const source = tab && store.sources.find((item) => item.id === tab.sourceId);
    if (source?.isEphemeral) setPendingDelete({ kind: "result", id: source.id, name: source.displayName });
    else store.closeTab(tabId);
  };

  const confirmDelete = async () => {
    const pending = pendingDelete;
    if (!pending) return;
    setPendingDelete(undefined);
    try {
      if (pending.kind === "result") {
        await bridge.CloseResult(pending.id);
        store.removeSource(pending.id);
      } else if (pending.kind === "dataset") {
        await bridge.RemoveDataset(pending.id);
        store.removeSource(pending.id);
      } else {
        await bridge.DeleteSavedQuery(pending.id);
        store.removeSavedQuery(pending.id);
      }
      toast.success(pending.kind === "query" ? "Saved query removed" : "Source removed");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const retryImport = async (options: ImportOptions) => {
    if (!retrySource?.sourcePath) return;
    setRetryBusy(true);
    const oldID = retrySource.id;
    try {
      const batch = await bridge.ImportPaths({ paths: [retrySource.sourcePath], options });
      store.removeSource(oldID);
      handleBatch(batch);
      setRetrySource(undefined);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setRetryBusy(false);
    }
  };

  const chooseSheet = async (sheet: string) => {
    const workbook = workbooks[0];
    if (!workbook) return;
    setSheetBusy(true);
    try {
      handleBatch(await bridge.StartXLSXImport({ path: workbook.path, sheets: [sheet], options: {} }));
      setWorkbooks((items) => items.slice(1));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSheetBusy(false);
    }
  };

  const content = activeSource ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-[10px] text-muted-foreground">
        <span className="truncate">SQL name: <code className="text-foreground">{activeSource.tableName}</code></span>
        <Button variant="ghost" size="icon-sm" aria-label="Copy SQL table name" onClick={() => void navigator.clipboard?.writeText(activeSource.tableName)}><Copy /></Button>
        {activeSource.originalSQL && <span className="min-w-0 flex-1 truncate border-l border-border pl-2 font-mono">{activeSource.originalSQL.replace(/\s+/g, " ")}</span>}
        <div className="ml-auto flex items-center gap-1">
          {activeSource.isEphemeral && <Button variant="secondary" size="sm" onClick={() => setSaveResultOpen(true)}><Save /> Save as table</Button>}
          <Button variant="ghost" size="sm" onClick={() => setPendingDelete({ kind: activeSource.isEphemeral ? "result" : "dataset", id: activeSource.id, name: activeSource.displayName })}><Trash2 /> {activeSource.isEphemeral ? "Discard" : "Remove"}</Button>
          <Button variant="ghost" size="sm" onClick={() => store.setPanel({ sqlCollapsed: !store.panel.sqlCollapsed })}><Code2 /> {store.panel.sqlCollapsed ? "Show SQL" : "Hide SQL"}</Button>
        </div>
      </div>
      <ImportStatusBanner
        source={activeSource}
        job={activeJob}
        onCancel={activeJob ? () => void cancelJob(activeJob) : undefined}
        onRetry={activeSource.sourcePath ? () => setRetrySource(activeSource) : undefined}
      />
      <div className="min-h-0 flex-1"><DataGrid source={activeSource} onViewStateChange={(view) => setGridViews((current) => ({ ...current, [activeSource.id]: view }))} /></div>
    </div>
  ) : store.sources.length ? (
    <div className="grid h-full place-items-center bg-background text-center"><div><p className="text-[13px] text-foreground">Choose a table from the workspace</p><p className="mt-1 text-[11px] text-muted-foreground">Open sources and SQL results appear as tabs.</p></div></div>
  ) : (
    <EmptyState onChoose={() => void openFiles()} dragActive={dragActive} />
  );

  if (!store.bootstrapped) {
    return <div className="ducs-shell grid place-items-center"><div className="text-center"><span className="ducs-pulse mx-auto block size-2 rounded-full bg-primary" /><p className="mt-3 text-[11px] text-muted-foreground">Opening local DuckDB workspace…</p></div></div>;
  }

  return (
    <TooltipProvider delayDuration={350}>
      <div className="ducs-shell flex flex-col text-foreground">
        <TopBar onOpen={() => void openFiles()} onExport={() => setExportOpen(true)} onToggleJobs={() => setJobsOpen(true)} activeJobs={activeJobs.length} canExport={Boolean(activeSource && activeSource.status === "ready")} />
        {bootstrapError && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{bootstrapError}</div>}
        <div className="min-h-0 flex-1">
          <PanelGroup direction="horizontal" onLayout={(sizes) => store.setPanel({ sidebarSize: sizes[0] })}>
            <Panel defaultSize={store.panel.sidebarSize} minSize={15} maxSize={32}>
              <Sidebar
                sources={store.sources}
                savedQueries={store.savedQueries}
                activeSourceId={activeSourceId}
                onSelectSource={store.selectSource}
                onInsertTable={(source) => store.insertIntoDraft(draftKey, quoteIdentifier(source.tableName))}
                onSelectSavedQuery={(query) => store.loadSavedQuery(query.id, draftKey)}
                onDeleteSavedQuery={(query) => setPendingDelete({ kind: "query", id: query.id, name: query.name })}
                onRemoveSource={(source) => setPendingDelete({ kind: "dataset", id: source.id, name: source.displayName })}
              />
            </Panel>
            <PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary" />
            <Panel minSize={65}>
              <main className="flex h-full min-h-0 flex-col bg-background">
                <TabsBar tabs={store.tabs} activeTabId={store.activeTabId} onSelect={store.selectTab} onClose={closeTab} />
                {store.sources.length === 0 ? content : store.panel.sqlCollapsed ? (
                  <>
                    <div className="min-h-0 flex-1">{content}</div>
                    <button className="flex h-8 shrink-0 items-center justify-center gap-1.5 border-t border-border bg-card text-[10px] text-muted-foreground hover:text-primary" onClick={() => store.setPanel({ sqlCollapsed: false })}><ChevronUp className="size-3" /> Open SQL editor</button>
                  </>
                ) : (
                  <PanelGroup direction="vertical" onLayout={(sizes) => sizes[1] && store.setPanel({ sqlSize: sizes[1] })}>
                    <Panel defaultSize={100 - store.panel.sqlSize} minSize={35}>{content}</Panel>
                    <PanelResizeHandle className="h-1 bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary" />
                    <Panel defaultSize={store.panel.sqlSize} minSize={18} maxSize={55} collapsible collapsedSize={0} onCollapse={() => store.setPanel({ sqlCollapsed: true })}>
                      <SQLPanel
                        value={sqlText}
                        onChange={(value) => store.setDraft(draftKey, value)}
                        onRun={() => void runQuery()}
                        onNew={() => { store.newDraft(draftKey); setQueryError(undefined); }}
                        onSave={() => setSaveQueryOpen(true)}
                        running={queryRunning}
                        disabled={readySources.length === 0}
                        disabledReason="Wait for a dataset to finish preparing"
                        sources={readySources}
                        history={store.history}
                        error={queryError}
                      />
                    </Panel>
                  </PanelGroup>
                )}
              </main>
            </Panel>
          </PanelGroup>
        </div>
        <StatusBar source={activeSource} jobs={store.jobs} />
      </div>

      <JobsPanel open={jobsOpen} onOpenChange={setJobsOpen} jobs={store.jobs} onCancel={(job) => void cancelJob(job)} />
      <SheetPicker workbook={workbooks[0]} open={workbooks.length > 0} onOpenChange={(open) => !open && setWorkbooks((items) => items.slice(1))} onConfirm={(sheet) => void chooseSheet(sheet)} busy={sheetBusy} />
      <RetryImportDialog open={Boolean(retrySource)} onOpenChange={(open) => !open && setRetrySource(undefined)} kind={retrySource?.kind} onConfirm={(options) => void retryImport(options)} busy={retryBusy} />
      <NameDialog open={saveQueryOpen} onOpenChange={setSaveQueryOpen} title="Save query" description="Saved SQL persists in this local workspace." initialName={activeSavedQuery?.name ?? ""} actionLabel="Save query" busy={saveQueryBusy} onSubmit={(name) => void saveQuery(name)} />
      <NameDialog open={saveResultOpen} onOpenChange={setSaveResultOpen} title="Save result as table" description="Create a persistent DuckDB table that can be used by future queries." initialName="" actionLabel="Save table" busy={saveResultBusy} onSubmit={(name) => void saveResult(name)} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} busy={exportBusy} onExport={(scope) => void exportCSV(scope)} />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(undefined)}
        title={pendingDelete?.kind === "result" ? "Discard this result?" : pendingDelete?.kind === "query" ? "Delete saved query?" : "Remove this dataset?"}
        description={pendingDelete?.kind === "result" ? `“${pendingDelete.name}” is ephemeral and will be dropped from DuckDB.` : pendingDelete?.kind === "query" ? `“${pendingDelete.name}” will be removed from saved SQL.` : `“${pendingDelete?.name ?? "This dataset"}” will be removed from the workspace. The original file will remain untouched.`}
        actionLabel={pendingDelete?.kind === "result" ? "Discard" : "Remove"}
        onConfirm={() => void confirmDelete()}
      />
      <Toaster theme="dark" position="bottom-right" richColors closeButton toastOptions={{ style: { background: "#0d120f", border: "1px solid #223029", color: "#eef6f1" } }} />
      {dragActive && store.sources.length > 0 && <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-primary backdrop-blur-sm"><div className="text-center"><p className="text-lg font-semibold">Drop to import</p><p className="mt-1 text-[11px] text-muted-foreground">Files are processed locally</p></div></div>}
    </TooltipProvider>
  );
}
