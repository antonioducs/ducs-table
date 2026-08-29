import { useEffect, useState } from "react";
import { Bot, Database, Settings2, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/bridge";
import { useAIStore } from "@/stores/ai-store";
import type { AIApprovalDecision, AIApprovalRequest, AIModelOption, AIProvider } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AIConversationPicker } from "./AIConversationPicker";
import { AIMessageList } from "./AIMessageList";
import { AIComposer } from "./AIComposer";
import { AIProviderSetupDialog } from "./AIProviderSetupDialog";

export interface AIChatPanelProps {
  projectId: string;
  projectName: string;
  sourceName?: string;
  onClose: () => void;
  onReplaceSQL: (sql: string) => void;
  onAppendSQL: (sql: string) => void;
  onExecuteSQL: (sql: string) => void;
}

const aiProviders: AIProvider[] = ["codex", "claude"];

export function AIChatPanel({ projectId, projectName, sourceName, onClose, onReplaceSQL, onAppendSQL, onExecuteSQL }: AIChatPanelProps) {
  const store = useAIStore();
  const [setupOpen, setSetupOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const [approvalBusy, setApprovalBusy] = useState<string>();
  const config = store.configByProject[projectId];
  const conversations = store.conversationsByProject[projectId] ?? [];
  const conversationId = store.activeConversationByProject[projectId];
  const messages = conversationId ? store.messagesByConversation[conversationId] ?? [] : [];
  const tools = conversationId ? store.toolsByConversation[conversationId] ?? [] : [];
  const approvals = conversationId ? store.approvalsByConversation[conversationId] ?? [] : [];
  const running = Boolean(conversationId && (store.sendingByConversation[conversationId] || store.runsByConversation[conversationId]?.state === "running"));
  const status = config ? store.providerStatus[config.provider] : undefined;
  const models: AIModelOption[] = aiProviders.flatMap((provider) => (
    store.providerStatus[provider]?.authenticated
      ? (store.modelsByProvider[provider] ?? []).map((model) => ({ provider, model }))
      : []
  ));
  const loading = Boolean(store.loadingProjects[projectId]);
  const ready = Boolean(status?.authenticated && config?.model);
  const contextLabel = sourceName ? `project ${projectName}; active source ${sourceName}` : `project ${projectName}`;

  useEffect(() => { void useAIStore.getState().initializeProject(projectId); }, [projectId]);

  const send = (prompt: string) => {
    if (!ready) { setSetupOpen(true); return; }
    if (!config?.consent) { setPendingPrompt(prompt); return; }
    void store.send(projectId, prompt, contextLabel).catch((error) => toast.error("AI message failed", { description: getErrorMessage(error) }));
  };

  const acceptConsent = () => {
    const prompt = pendingPrompt;
    setPendingPrompt(undefined);
    if (prompt) void store.send(projectId, prompt, contextLabel, true).catch((error) => toast.error("AI message failed", { description: getErrorMessage(error) }));
  };

  const respondApproval = async (approval: AIApprovalRequest, decision: AIApprovalDecision) => {
    setApprovalBusy(approval.id);
    try { await store.respondApproval(approval.id, decision); }
    catch (error) { toast.error("Could not answer approval", { description: getErrorMessage(error) }); }
    finally { setApprovalBusy(undefined); }
  };

  return (
    <aside aria-label="AI assistant" className="ducs-glass-panel flex h-full min-h-0 flex-col border-l border-border bg-card">
      <div className="ducs-glass-bar flex h-12 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="grid size-7 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary shadow-[inset_0_1px_0_rgba(215,255,235,.08)]">
          <Bot className="size-4" />
        </span>
        <span className="ducs-display text-[13px] text-foreground">AI assistant</span>
        {running && <span className="ducs-live-dot ml-0.5" aria-hidden="true" />}
        <Button variant="ghost" size="icon-sm" className="ml-auto hover:[&_svg]:rotate-45 [&_svg]:transition-transform [&_svg]:duration-300" aria-label="AI settings" onClick={() => setSetupOpen(true)}><Settings2 /></Button>
        <Button variant="ghost" size="icon-sm" className="hover:bg-destructive/15 hover:text-destructive" aria-label="Close AI panel" onClick={onClose}><X /></Button>
      </div>
      <div className="space-y-2 border-b border-border p-2">
        <AIConversationPicker
          conversations={conversations}
          value={conversationId}
          disabled={loading || running}
          onSelect={(id) => void store.selectConversation(projectId, id).catch((error) => toast.error(getErrorMessage(error)))}
          onCreate={() => void store.createConversation(projectId).catch((error) => { if (!ready) setSetupOpen(true); else toast.error(getErrorMessage(error)); })}
          onDelete={(id) => void store.deleteConversation(projectId, id).catch((error) => toast.error(getErrorMessage(error)))}
        />
        <div className="flex min-w-0 items-center gap-1 text-[9px] text-muted-foreground">
          <Badge variant="muted" className="max-w-[48%] truncate">{projectName}</Badge>
          {sourceName && <Badge variant="muted" className="max-w-[48%] truncate"><Database className="mr-1 size-2.5" />{sourceName}</Badge>}
        </div>
      </div>
      {store.errorByProject[projectId] && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[10px] text-destructive">{store.errorByProject[projectId]}</div>}
      {!loading && !ready && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/25 bg-warning/[0.07] px-2.5 py-2 text-[10.5px] text-warning">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 leading-4">Choose and authenticate a provider to use AI.</p>
          <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setSetupOpen(true)}>Set up</Button>
        </div>
      )}
      <AIMessageList messages={messages} tools={tools} approvals={approvals} approvalBusy={approvalBusy} onApproval={(approval, decision) => void respondApproval(approval, decision)} onReplace={onReplaceSQL} onAppend={onAppendSQL} onExecute={onExecuteSQL} />
      <AIComposer
        disabled={loading || !ready}
        modelSelectionDisabled={loading}
        running={running}
        placeholder={sourceName ? `Ask about ${sourceName}…` : `Ask about ${projectName}…`}
        config={config}
        models={models}
        onModelChange={(provider, model) => store.setConfig(projectId, { provider, model, reasoningEffort: undefined })}
        onEffortChange={(reasoningEffort) => store.setConfig(projectId, { reasoningEffort })}
        onFastModeChange={(fastMode) => store.setConfig(projectId, { fastMode })}
        onSend={send}
        onStop={() => void store.stop(projectId).catch((error) => toast.error(getErrorMessage(error)))}
      />

      <AIProviderSetupDialog open={setupOpen} projectId={projectId} onOpenChange={setSetupOpen} />
      <Dialog open={Boolean(pendingPrompt)} onOpenChange={(open) => { if (!open) setPendingPrompt(undefined); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Allow AI for this workspace?</DialogTitle><DialogDescription>Your prompt, project/source metadata, and results from bounded tools may be sent to {config?.provider === "claude" ? "Anthropic Claude" : "OpenAI Codex"}. Database credentials and unrestricted database access are never shared. Query previews require a separate approval each time.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="ghost" onClick={() => setPendingPrompt(undefined)}>Cancel</Button><Button onClick={acceptConsent}>I understand, send</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

export default AIChatPanel;
