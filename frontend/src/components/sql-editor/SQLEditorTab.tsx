import { useCallback, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { AlignLeft, AlertTriangle, Clock3, Copy, Play, Save } from "lucide-react";
import { toast } from "sonner";
import type { ExternalRelationInfo, SourceInfo, SQLDocument } from "@/types";
import type { QueryHistoryEntry } from "@/stores/app-store";
import { sqlCompletionOptions } from "./completion";
import { formatDuckDBSQL } from "./sql-format";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SQLEditorTabProps = {
  document: SQLDocument;
  onChange: (value: string) => void;
  onRun: (sql?: string) => void;
  onSave: () => void;
  running: boolean;
  disabled?: boolean;
  disabledReason?: string;
  sources: SourceInfo[];
  externalRelations?: ExternalRelationInfo[];
  history?: QueryHistoryEntry[];
  error?: string;
};

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "rgba(8,8,11,.88)" },
  ".cm-scroller": { minHeight: "0", overflowX: "hidden", overflowY: "scroll", scrollbarGutter: "stable", overscrollBehavior: "contain" },
  ".cm-content": { minWidth: "0", width: "100%", padding: "8px 0", caretColor: "#8b7cf6" },
  ".cm-line": { padding: "0 10px" },
  ".cm-tooltip": { backgroundColor: "rgba(19,19,23,.96)", border: "1px solid rgba(255,255,255,.1)", backdropFilter: "blur(24px)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgba(139,124,246,.16)", color: "#f4f4f5" },
  "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "rgba(139,124,246,.22)" },
}, { dark: true });

function completionSource(sources: SourceInfo[], externalRelations: ExternalRelationInfo[]) {
  const options = sqlCompletionOptions(sources, externalRelations);
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options, validFor: /^[\w$]*$/ };
  };
}

/**
 * One SQL document rendered as workbench tab content. Unlike the previous fixed
 * bottom panel, running, saving and errors are scoped to this document.
 */
export function SQLEditorTab({
  document,
  onChange,
  onRun,
  onSave,
  running,
  disabled = false,
  disabledReason,
  sources,
  externalRelations = [],
  history = [],
  error,
}: SQLEditorTabProps) {
  const [formatting, setFormatting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const selectedSQLRef = useRef<string | undefined>(undefined);
  const extensions = useMemo(() => [
    sql({ upperCaseKeywords: true }),
    autocompletion({ override: [completionSource(sources, externalRelations)] }),
    EditorView.lineWrapping,
    editorTheme,
  ], [externalRelations, sources]);

  const value = document.sql;

  const onEditorUpdate = useCallback((update: ViewUpdate) => {
    if (!update.selectionSet && !update.docChanged) return;
    const { from, to } = update.state.selection.main;
    const selected = from === to ? "" : update.state.doc.sliceString(from, to).trim();
    selectedSQLRef.current = selected || undefined;
    setHasSelection(Boolean(selected));
  }, []);

  const executeQuery = () => {
    if (disabled || running) return;
    onRun(selectedSQLRef.current);
  };

  const onFormat = async () => {
    if (!value.trim() || formatting) return;
    setFormatting(true);
    try {
      const formatted = await formatDuckDBSQL(value);
      if (formatted !== value) onChange(formatted);
    } catch (error) {
      toast.error("Could not format query", {
        description: error instanceof Error ? error.message : "The SQL formatter rejected this query.",
      });
    } finally {
      setFormatting(false);
    }
  };

  const copyQuery = async () => {
    try {
      await copyText(value);
      toast.success("Query copied");
    } catch {
      toast.error("Could not copy query");
    }
  };

  const copyError = async () => {
    if (!error) return;
    try {
      await copyText(error);
      toast.success("Error copied");
    } catch {
      toast.error("Could not copy error");
    }
  };

  const onShortcut = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      executeQuery();
    } else if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      onSave();
    } else if (event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      void onFormat();
    }
  };

  return (
    <section aria-label={`SQL editor ${document.title}`} className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <span className="mr-1 min-w-0 max-w-40 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground" title={document.title}>
          {document.title}
        </span>
        <Button size="sm" onClick={executeQuery} disabled={disabled || running || (!hasSelection && !value.trim())}>
          <Play className={running ? "ducs-pulse" : ""} /> {running ? "Running…" : hasSelection ? "Run selection" : "Run"}
          <kbd className="ml-1 rounded border border-black/15 px-1 font-mono text-[9px] opacity-65">⌘↵</kbd>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void onFormat()} disabled={running || formatting || !value.trim()} title="Format query (⌘⇧F)">
          <AlignLeft className={formatting ? "ducs-pulse" : ""} /> {formatting ? "Formatting…" : "Format"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void copyQuery()} disabled={!value}><Copy /> Copy query</Button>
        <Button variant="ghost" size="sm" onClick={onSave}><Save /> {document.savedQueryId ? "Update saved" : "Save query"}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm"><Clock3 /> History</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[420px]">
            <DropdownMenuLabel>Recent executions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {history.length === 0 ? (
              <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">No queries run yet</p>
            ) : history.slice(0, 12).map((item) => (
              <DropdownMenuItem key={item.id} onSelect={() => onChange(item.sql)} className="h-auto items-start py-2">
                <span className={`mt-1 size-1.5 shrink-0 rounded-full ${item.status === "success" ? "bg-primary" : "bg-destructive"}`} />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px]">{item.sql.replace(/\s+/g, " ")}</span>
                  <span className="mt-0.5 block text-[9px] text-muted-foreground">{new Date(item.ranAt).toLocaleString()}{item.durationMs !== undefined ? ` · ${item.durationMs}ms` : ""}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto truncate pl-2 text-[10px] text-muted-foreground">
          {disabled ? disabledReason ?? "Wait for data to become available" : `${sources.length + externalRelations.length} relation${sources.length + externalRelations.length === 1 ? "" : "s"} available`}
        </div>
      </div>

      {error && (
        <div role="alert" className="flex max-h-32 shrink-0 items-start gap-2 overflow-hidden border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="ducs-selectable-text max-h-28 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words leading-5">{error}</span>
          <Button variant="ghost" size="sm" className="h-6 text-destructive hover:text-destructive" onClick={() => void copyError()}><Copy /> Copy error</Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden" onKeyDownCapture={onShortcut}>
        <CodeMirror
          className="ducs-sql-editor h-full min-h-0 overflow-hidden"
          value={value}
          onChange={onChange}
          onUpdate={onEditorUpdate}
          height="100%"
          extensions={extensions}
          editable={!running}
          basicSetup={{
            lineNumbers: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            foldGutter: false,
          }}
          placeholder="SELECT * FROM your_table LIMIT 100"
          aria-label={`SQL query ${document.title}`}
        />
      </div>
    </section>
  );
}

export default SQLEditorTab;
