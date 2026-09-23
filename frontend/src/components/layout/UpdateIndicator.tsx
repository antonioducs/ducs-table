import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpCircle, Download, ExternalLink, FolderSearch, LoaderCircle, RefreshCw, RotateCw, ShieldCheck, SkipForward } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/layout/ActionDialogs";
import { getErrorMessage } from "@/lib/bridge";
import {
  isUpdateBusy,
  updateNeedsAttention,
  updatePrimaryAction,
  updatePrimaryLabel,
  updateStatusLine,
  updateTriggerLabel,
} from "@/lib/update-status";
import { cn } from "@/lib/utils";
import { useUpdateStore } from "@/stores/update-store";
import type { UpdateState } from "@/types";

export interface UpdateIndicatorProps {
  /** Queued or running jobs; restarting to update would interrupt them. */
  activeJobs?: number;
}

function run(action: () => Promise<void>, failure: string) {
  void action().catch((error: unknown) => toast.error(failure, { description: getErrorMessage(error) }));
}

function triggerIcon(state: UpdateState): ReactNode {
  switch (state.phase) {
    case "checking":
    case "installing":
      return <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />;
    case "available":
      return <ArrowUpCircle className="size-3" aria-hidden="true" />;
    case "downloading":
      return <Download className="ducs-pulse size-3" aria-hidden="true" />;
    case "verifying":
      return <ShieldCheck className="ducs-pulse size-3" aria-hidden="true" />;
    case "ready":
      return state.mode === "installer" ? <RotateCw className="size-3" aria-hidden="true" /> : <FolderSearch className="size-3" aria-hidden="true" />;
    default:
      return null;
  }
}

function primaryIcon(state: UpdateState): ReactNode {
  switch (updatePrimaryAction(state)) {
    case "download": return <Download aria-hidden="true" />;
    case "open-release": return <ExternalLink aria-hidden="true" />;
    case "install": return <RotateCw aria-hidden="true" />;
    case "reveal": return <FolderSearch aria-hidden="true" />;
    default: return null;
  }
}

export function UpdateIndicator({ activeJobs = 0 }: UpdateIndicatorProps) {
  const state = useUpdateStore((store) => store.state);
  const [confirmRestart, setConfirmRestart] = useState(false);

  const install = () => run(() => useUpdateStore.getState().install(), "Could not install the update");
  const primary = (current: UpdateState) => {
    const store = useUpdateStore.getState();
    switch (updatePrimaryAction(current)) {
      case "download": run(store.download, "Could not download the update"); break;
      case "open-release": run(store.openRelease, "Could not open the release page"); break;
      case "reveal": run(store.reveal, "Could not show the update in Finder"); break;
      case "install":
        if (activeJobs > 0) setConfirmRestart(true);
        else install();
        break;
    }
  };
  const primaryRef = useRef(primary);
  primaryRef.current = primary;

  // One toast per version and milestone per session; the status bar control
  // stays visible afterwards.
  const announced = useRef(new Set<string>());
  useEffect(() => {
    if (!state?.availableVersion) return;
    const milestone = state.phase === "available" ? "available" : state.phase === "ready" && state.mode === "installer" ? "ready" : undefined;
    const key = `${milestone}:${state.availableVersion}`;
    if (!milestone || announced.current.has(key)) return;
    announced.current.add(key);
    const label = updatePrimaryLabel(state);
    const action = label ? { label, onClick: () => primaryRef.current(state) } : undefined;
    if (milestone === "available") toast.info(`Duc's Table ${state.availableVersion} is available`, { description: "Release notes and options are in the status bar.", action });
    else toast.success(`Duc's Table ${state.availableVersion} is ready to install`, { description: "Restart to finish updating.", action });
  }, [state]);

  if (!state) return null;
  if (state.mode === "off") {
    return <span className="ducs-num text-muted-foreground/80" title={state.modeReason}>v{state.currentVersion}</span>;
  }

  const busy = isUpdateBusy(state);
  const attention = updateNeedsAttention(state);
  const primaryLabel = updatePrimaryLabel(state);
  const store = () => useUpdateStore.getState();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={attention ? `${updateTriggerLabel(state)}, update options` : `Duc's Table ${state.currentVersion}, update options`}
            className={cn(
              "ducs-num flex h-5 items-center gap-1.5 rounded-full px-1.5 outline-none transition-colors duration-150 ease-soft focus-visible:ring-2 focus-visible:ring-ring",
              attention
                ? "border border-primary/30 bg-primary/12 px-2 font-medium text-brand-300 shadow-[0_0_14px_-6px_rgba(52,224,127,.7)] hover:bg-primary/20"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {triggerIcon(state)}
            {updateTriggerLabel(state)}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-80 p-1.5">
          <div className="px-2 pb-2 pt-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12.5px] font-medium text-foreground">Duc's Table updates</span>
              <span className="ducs-num text-[11px] text-muted-foreground">v{state.currentVersion}</span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground" aria-live="polite">{updateStatusLine(state)}</p>
            {state.phase === "downloading" && (
              <div
                role="progressbar"
                aria-label="Update download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(state.progress ?? 0)}
                className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-primary transition-[width] duration-200 ease-soft" style={{ width: `${Math.min(100, state.progress ?? 0)}%` }} />
              </div>
            )}
            {state.error && <p role="alert" className="mt-1.5 text-[11px] leading-4 text-destructive">{state.error}</p>}
            {state.modeReason && state.mode !== "installer" && (
              <p className="mt-1.5 text-[10.5px] leading-4 text-muted-foreground/80">{state.modeReason}</p>
            )}
          </div>
          {primaryLabel && (
            <DropdownMenuItem className="font-medium text-brand-300 focus:text-brand-300" onSelect={() => primary(state)}>
              {primaryIcon(state)} {primaryLabel}
            </DropdownMenuItem>
          )}
          {state.availableVersion && updatePrimaryAction(state) !== "open-release" && (
            <DropdownMenuItem onSelect={() => run(store().openRelease, "Could not open the release page")}>
              <ExternalLink aria-hidden="true" /> Release notes
            </DropdownMenuItem>
          )}
          {state.availableVersion && !busy && (
            <DropdownMenuItem onSelect={() => run(store().skip, "Could not skip this version")}>
              <SkipForward aria-hidden="true" /> Skip this version
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={busy}
            onSelect={(event) => {
              event.preventDefault();
              run(store().check, "Could not check for updates");
            }}
          >
            <RefreshCw className={cn(state.phase === "checking" && "animate-spin")} aria-hidden="true" /> Check for updates
          </DropdownMenuItem>
          <DropdownMenuCheckboxItem
            checked={state.autoCheck}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => run(() => store().setAutoCheck(checked === true), "Could not save the update preference")}
          >
            Check automatically
          </DropdownMenuCheckboxItem>
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-4 text-muted-foreground/70">
            Checks ask api.github.com for the latest release and send only the app version. Updates are installed only when signed with this copy's Developer ID.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Restart to update now?"
        description={`${activeJobs} job${activeJobs === 1 ? " is" : "s are"} still running. Restarting cancels ${activeJobs === 1 ? "it" : "them"}; imported data that already finished is kept.`}
        actionLabel="Restart and update"
        onConfirm={install}
      />
    </>
  );
}
