import { ShieldAlert } from "lucide-react";
import type { AIApprovalDecision, AIApprovalRequest } from "@/types";
import { Button } from "@/components/ui/button";

export function AIApprovalCard({ approval, busy, onRespond }: { approval: AIApprovalRequest; busy?: boolean; onRespond: (decision: AIApprovalDecision) => void }) {
  const input = approval.input && typeof approval.input === "object" ? approval.input as Record<string, unknown> : {};
  const sql = typeof input.sql === "string" ? input.sql : undefined;
  return (
    <div className="ducs-selectable-text my-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[10px]">
      <div className="flex items-center gap-1.5 font-semibold text-amber-300"><ShieldAlert className="size-3.5" /> Approval required</div>
      <p className="mt-1 leading-4 text-foreground">{approval.summary}</p>
      <p className="mt-1 font-mono text-muted-foreground">{approval.tool}</p>
      {sql && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-amber-500/20 bg-black/20 p-2 font-mono text-[10px] text-foreground">{sql}</pre>}
      <p className="mt-2 text-[9px] leading-3 text-muted-foreground">Conversation access is temporary and only skips repeated prompts; every preview remains read-only and bounded.</p>
      <div className="mt-2 flex flex-wrap justify-end gap-1">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRespond("deny")}>Deny</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRespond("allow_once")}>Allow once</Button>
        <Button size="sm" disabled={busy} onClick={() => onRespond("allow_conversation")}>Allow for this conversation</Button>
      </div>
    </div>
  );
}
