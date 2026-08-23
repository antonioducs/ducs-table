import { CheckCircle2, LoaderCircle, Wrench, XCircle } from "lucide-react";
import type { AIToolActivity } from "@/stores/ai-store";
import { cn } from "@/lib/utils";
import { AISQLCard, type AISQLCardProps } from "./AISQLCard";
import { AIPreviewTable } from "./AIPreviewTable";
import { readAIPreviewResult } from "./ai-preview-result";

function findSQL(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sql = (value as Record<string, unknown>).sql;
  return typeof sql === "string" && sql.trim() ? sql : undefined;
}

export function AIToolCard({ tool, ...sqlActions }: { tool: AIToolActivity } & Omit<AISQLCardProps, "sql">) {
  const sql = findSQL(tool.output) ?? findSQL(tool.input);
  const preview = tool.name === "preview_query" ? readAIPreviewResult(tool.output) : undefined;
  const Icon = tool.status === "running" ? LoaderCircle : tool.status === "error" ? XCircle : CheckCircle2;
  return (
    <div className="my-2 rounded-md border border-border bg-background/60 p-2 text-[10px]">
      <div className="flex items-center gap-1.5">
        <Wrench className="size-3 text-muted-foreground" />
        <span className="font-mono text-foreground">{tool.name}</span>
        <Icon className={cn("ml-auto size-3", tool.status === "running" && "animate-spin text-primary", tool.status === "error" && "text-destructive", tool.status === "complete" && "text-primary")} />
      </div>
      {tool.error && <p role="alert" className="mt-1 text-destructive">{tool.error}</p>}
      {sql && <AISQLCard sql={sql} {...sqlActions} />}
      {preview && <AIPreviewTable result={preview} />}
      {tool.status !== "running" && tool.output !== undefined && !preview && (!sql || tool.name === "preview_query") && (
        <details className="mt-1 text-muted-foreground"><summary className="cursor-pointer">Tool output</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(tool.output, null, 2)}</pre></details>
      )}
    </div>
  );
}
