import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { AlertTriangle, Clock3, Copy, FilePlus2, Play, Save } from "lucide-react";
import type { ExternalRelationInfo, SourceInfo } from "@/types";
import type { QueryHistoryEntry } from "@/stores/app-store";
import { sqlCompletionOptions } from "./completion";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SQLPanelProps = {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  onNew: () => void;
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
  "&": { height: "100%", backgroundColor: "#0a0f0c" },
  ".cm-content": { padding: "8px 0", caretColor: "#32e67e" },
  ".cm-line": { padding: "0 10px" },
  ".cm-tooltip": { backgroundColor: "#0d120f", border: "1px solid #223029" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#17231d", color: "#eef6f1" },
  "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "rgba(50,230,126,.2)" },
}, { dark: true });

function completionSource(sources: SourceInfo[], externalRelations: ExternalRelationInfo[]) {
  const options = sqlCompletionOptions(sources, externalRelations);
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options, validFor: /^[\w$]*$/ };
  };
}

export function SQLPanel({
  value,
  onChange,
  onRun,
  onNew,
  onSave,
  running,
  disabled = false,
  disabledReason,
  sources,
  externalRelations = [],
  history = [],
  error,
}: SQLPanelProps) {
  const extensions = useMemo(() => [
    sql({ upperCaseKeywords: true }),
    autocompletion({ override: [completionSource(sources, externalRelations)] }),
    editorTheme,
  ], [externalRelations, sources]);

  const onShortcut = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled && !running) onRun();
    } else if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      onSave();
    }
  };

  return (
    <section aria-label="SQL editor" className="flex h-full min-h-0 flex-col border-t border-border bg-card">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">SQL</span>
        <Button size="sm" onClick={onRun} disabled={disabled || running || !value.trim()}>
          <Play className={running ? "ducs-pulse" : ""} /> {running ? "Running…" : "Run"}
          <kbd className="ml-1 rounded border border-black/15 px-1 font-mono text-[9px] opacity-65">⌘↵</kbd>
        </Button>
        <Button variant="ghost" size="sm" onClick={onNew}><FilePlus2 /> New query</Button>
        <Button variant="ghost" size="sm" onClick={onSave}><Save /> Save query</Button>
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
        <div className="ml-auto text-[10px] text-muted-foreground">
          {disabled ? disabledReason ?? "Wait for data to become available" : `${sources.length + externalRelations.length} relation${sources.length + externalRelations.length === 1 ? "" : "s"} available`}
        </div>
      </div>

      {error && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <Button variant="ghost" size="sm" className="h-6 text-destructive hover:text-destructive" onClick={() => void navigator.clipboard?.writeText(error)}><Copy /> Copy error</Button>
        </div>
      )}

      <div className="min-h-0 flex-1" onKeyDownCapture={onShortcut}>
        <CodeMirror
          value={value}
          onChange={onChange}
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
          aria-label="SQL query"
        />
      </div>
    </section>
  );
}

export default SQLPanel;
