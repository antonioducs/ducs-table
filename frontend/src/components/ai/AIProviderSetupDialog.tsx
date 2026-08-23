import { useEffect, useState } from "react";
import { LogIn, LogOut, RefreshCw } from "lucide-react";
import type { AIProvider } from "@/types";
import { getErrorMessage } from "@/lib/bridge";
import { useAIStore } from "@/stores/ai-store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AIModelPicker } from "./AIModelPicker";

export function AIProviderSetupDialog({ open, projectId, onOpenChange }: { open: boolean; projectId: string; onOpenChange: (open: boolean) => void }) {
  const store = useAIStore();
  const config = store.configByProject[projectId] ?? { projectId, provider: "codex" as const, model: "", fastMode: false, consent: false };
  const status = store.providerStatus[config.provider];
  const models = store.modelsByProvider[config.provider] ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { if (open && !status) void store.refreshProvider(config.provider).catch((cause) => setError(getErrorMessage(cause))); }, [config.provider, open, status, store]);

  const chooseProvider = async (provider: AIProvider) => {
    store.setConfig(projectId, { provider, model: "", reasoningEffort: undefined, fastMode: false });
    setBusy(true); setError(undefined);
    try {
      await store.refreshProvider(provider);
      const first = useAIStore.getState().modelsByProvider[provider]?.[0];
      if (first) useAIStore.getState().setConfig(projectId, { model: first.id });
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const authenticate = async () => {
    setBusy(true); setError(undefined);
    try { await store.loginProvider(config.provider); }
    catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    setBusy(true); setError(undefined);
    try { await store.logoutProvider(config.provider); }
    catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Set up AI provider</DialogTitle><DialogDescription>Provider CLIs run locally. Prompts and approved tool results are sent to the selected provider; database credentials are never exposed.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-[10px] text-muted-foreground">Provider
            <Select value={config.provider} onValueChange={(value) => void chooseProvider(value as AIProvider)} disabled={busy}>
              <SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="codex">OpenAI Codex</SelectItem><SelectItem value="claude">Anthropic Claude</SelectItem></SelectContent>
            </Select>
          </label>
          <div className="rounded-md border border-border p-3 text-[11px]">
            <div className="flex items-center gap-2"><span className={`size-2 rounded-full ${status?.authenticated ? "bg-primary" : "bg-muted-foreground"}`} /><span>{status?.authenticated ? "Authenticated" : status?.available ? "Login required" : "Provider unavailable"}</span>{status?.version && <span className="ml-auto text-muted-foreground">{status.version}</span>}</div>
            {status?.error && <p className="mt-1 text-destructive">{status.error}</p>}
            <div className="mt-2 flex gap-1">
              {status?.authenticated ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void logout()}><LogOut /> Logout</Button> : <Button size="sm" disabled={busy || status?.available === false} onClick={() => void authenticate()}><LogIn /> Login</Button>}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void store.refreshProvider(config.provider).catch((cause) => setError(getErrorMessage(cause)))}><RefreshCw /> Refresh</Button>
            </div>
          </div>
          <label className="grid gap-1 text-[10px] text-muted-foreground">Model<AIModelPicker models={models} value={config.model} disabled={busy || !status?.authenticated} onChange={(model) => store.setConfig(projectId, { model, reasoningEffort: undefined })} /></label>
          {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button><Button disabled={!status?.authenticated || !config.model} onClick={() => onOpenChange(false)}>Use this model</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
