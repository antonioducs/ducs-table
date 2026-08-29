import { useCallback, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { AlignLeft, AlertTriangle, Clock3, Copy, FileCode2, Play, Save } from "lucide-react";
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
  "&": { height: "100%", backgroundColor: "rgba(5,9,7,.88)" },
  ".cm-scroller": { minHeight: "0", overflowX: "hidden", overflowY: "scroll", scrollbarGutter: "stable", overscrollBehavior: "contain" },
  ".cm-content": { minWidth: "0", width: "100%", padding: "10px 0", caretColor: "#34e07f" },
  ".cm-line": { padding: "0 12px" },
  ".cm-tooltip": {
    backgroundColor: "rgba(15,21,18,.96)",
    border: "1px solid rgba(160,255,205,.12)",
    borderRadius: "10px",
    overflow: "hidden",
    backdropFilter: "blur(26px) saturate(140%)",
    boxShadow: "0 22px 56px rgba(0,0,0,.62)",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgba(52,224,127,.18)", color: "#f2fbf6" },
  ".cm-completionIcon": { color: "#61f2a8", opacity: "0.9" },
  ".cm-completionDetail": { color: "#8b9c93", fontStyle: "normal" },
  "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "rgba(52,224,127,.24)" },
}, { dark: true });

/* Syntax palette: brand green for keywords, cool mint for identifiers, warm
   sand for literals — readable without fighting the neon accent. */
const syntaxTheme = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: "#61f2a8", fontWeight: "600" },
  { tag: tags.operator, color: "#8fd7bd" },
  { tag: tags.special(tags.variableName), color: "#c8ffe1" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#7fe3ff" },
  { tag: [tags.string, tags.special(tags.string)], color: "#ffd98a" },
  { tag: tags.number, color: "#ffbf7d" },
  { tag: tags.bool, color: "#ff9ecb" },
  { tag: tags.null, color: "#ff9ecb" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#5f7a6e", fontStyle: "italic" },
  { tag: tags.typeName, color: "#9fe8c9" },
  { tag: tags.punctuation, color: "#7d9188" },
  { tag: tags.variableName, color: "#dceae3" },
  { tag: tags.propertyName, color: "#dceae3" },
]));

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
  const relationCount = sources.length + externalRelations.length;
  const [formatting, setFormatting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const selectedSQLRef = useRef<string | undefined>(undefined);
  const extensions = useMemo(() => [
    sql({ upperCaseKeywords: true }),
    autocompletion({ override: [completionSource(sources, externalRelations)] }),
    EditorView.lineWrapping,
    editorTheme,
    syntaxTheme,
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
      <div className="ducs-glass-bar flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        {/* Narrow splits squeeze this first; keep enough room for a readable stub. */}
        <span className="mr-1 flex min-w-16 max-w-44 items-center gap-1.5" title={document.title}>
          <FileCode2 className="size-3.5 shrink-0 text-primary/80" aria-hidden="true" />
          <span className="ducs-display min-w-0 truncate text-[12px] text-foreground/90">{document.title}</span>
        </span>
        <Button size="sm" onClick={executeQuery} disabled={disabled || running || (!hasSelection && !value.trim())}>
          <Play className={running ? "ducs-pulse" : ""} /> {running ? "Running…" : hasSelection ? "Run selection" : "Run"}
          <kbd className="ml-1 rounded border border-black/20 bg-black/10 px-1 text-[9px] opacity-70">⌘↵</kbd>
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
                <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${item.status === "success" ? "bg-primary shadow-[0_0_8px_rgba(52,224,127,.8)]" : "bg-destructive shadow-[0_0_8px_rgba(255,107,107,.8)]"}`} />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px]">{item.sql.replace(/\s+/g, " ")}</span>
                  <span className="mt-0.5 block text-[9px] text-muted-foreground">{new Date(item.ranAt).toLocaleString()}{item.durationMs !== undefined ? ` · ${item.durationMs}ms` : ""}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div
          className="ducs-num ml-auto truncate pl-2 text-[10px] text-muted-foreground"
          title={disabled ? undefined : `${relationCount} relation${relationCount === 1 ? "" : "s"} available to query`}
        >
          {disabled ? disabledReason ?? "Wait for data to become available" : `${relationCount} relation${relationCount === 1 ? "" : "s"}`}
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
