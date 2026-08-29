import { Clipboard, FileInput, ListPlus, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

export interface AISQLCardProps {
  sql: string;
  onReplace?: (sql: string) => void;
  onAppend?: (sql: string) => void;
  onExecute?: (sql: string) => void;
}

export function AISQLCard({ sql, onReplace, onAppend, onExecute }: AISQLCardProps) {
  const copy = async () => {
    try {
      await copyText(sql);
      toast.success("SQL copied");
    } catch {
      toast.error("Could not copy SQL");
    }
  };
  return (
    <div className="group/sql my-2 overflow-hidden rounded-xl border border-border bg-black/35 backdrop-blur-lg transition-colors duration-200 ease-soft hover:border-primary/30">
      <div className="flex items-center gap-1 border-b border-border bg-primary/[0.05] px-2 py-1">
        <span className="ducs-eyebrow mr-auto text-primary">SQL</span>
        <Button variant="ghost" size="icon-sm" aria-label="Copy SQL" onClick={() => void copy()}><Clipboard /></Button>
        {onReplace && <Button variant="ghost" size="icon-sm" aria-label="Replace SQL editor" onClick={() => onReplace(sql)}><FileInput /></Button>}
        {onAppend && <Button variant="ghost" size="icon-sm" aria-label="Append to SQL editor" onClick={() => onAppend(sql)}><ListPlus /></Button>}
        {onExecute && <Button variant="ghost" size="icon-sm" aria-label="Execute SQL" onClick={() => onExecute(sql)}><Play /></Button>}
      </div>
      <pre className="ducs-selectable-text max-h-56 overflow-auto whitespace-pre-wrap p-2.5 font-mono text-[10.5px] leading-5 text-brand-100"><code>{sql}</code></pre>
    </div>
  );
}
