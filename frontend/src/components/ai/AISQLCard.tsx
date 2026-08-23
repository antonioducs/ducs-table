import { Clipboard, FileInput, ListPlus, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export interface AISQLCardProps {
  sql: string;
  onReplace?: (sql: string) => void;
  onAppend?: (sql: string) => void;
  onExecute?: (sql: string) => void;
}

export function AISQLCard({ sql, onReplace, onAppend, onExecute }: AISQLCardProps) {
  const copy = async () => {
    await navigator.clipboard?.writeText(sql);
    toast.success("SQL copied");
  };
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-black/30 backdrop-blur-lg">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="mr-auto text-[9px] font-semibold uppercase tracking-wider text-primary">SQL</span>
        <Button variant="ghost" size="icon-sm" aria-label="Copy SQL" onClick={() => void copy()}><Clipboard /></Button>
        {onReplace && <Button variant="ghost" size="icon-sm" aria-label="Replace SQL editor" onClick={() => onReplace(sql)}><FileInput /></Button>}
        {onAppend && <Button variant="ghost" size="icon-sm" aria-label="Append to SQL editor" onClick={() => onAppend(sql)}><ListPlus /></Button>}
        {onExecute && <Button variant="ghost" size="icon-sm" aria-label="Execute SQL" onClick={() => onExecute(sql)}><Play /></Button>}
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap p-2 font-mono text-[10px] leading-5 text-foreground"><code>{sql}</code></pre>
    </div>
  );
}
