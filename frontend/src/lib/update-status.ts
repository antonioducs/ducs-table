import type { UpdateState } from "@/types";
import { formatBytes } from "@/lib/utils";

export type UpdatePrimaryAction = "download" | "install" | "reveal" | "open-release";

export function isUpdateBusy(state: UpdateState): boolean {
  return state.phase === "checking" || state.phase === "downloading" || state.phase === "verifying" || state.phase === "installing";
}

/** True when the status bar should draw attention to the update control. */
export function updateNeedsAttention(state: UpdateState): boolean {
  return state.phase === "available" || state.phase === "downloading" || state.phase === "verifying" || state.phase === "ready" || state.phase === "installing";
}

export function updatePrimaryAction(state: UpdateState): UpdatePrimaryAction | undefined {
  if (state.phase === "available") return state.mode === "notify" ? "open-release" : "download";
  if (state.phase === "ready") return state.mode === "installer" ? "install" : "reveal";
  return undefined;
}

export function updatePrimaryLabel(state: UpdateState): string | undefined {
  switch (updatePrimaryAction(state)) {
    case "download": return `Download ${state.availableVersion}`;
    case "open-release": return `Get ${state.availableVersion} on GitHub`;
    case "install": return "Restart to update";
    case "reveal": return "Show update in Finder";
    default: return undefined;
  }
}

export function updateTriggerLabel(state: UpdateState): string {
  const version = state.availableVersion;
  switch (state.phase) {
    case "available": return `Update ${version}`;
    case "downloading": return `Downloading ${Math.floor(state.progress ?? 0)}%`;
    case "verifying": return "Verifying update";
    case "ready": return state.mode === "installer" ? "Restart to update" : "Update ready";
    case "installing": return "Installing update";
    default: return `v${state.currentVersion}`;
  }
}

export function updateStatusLine(state: UpdateState, now = Date.now()): string {
  const version = state.availableVersion;
  switch (state.phase) {
    case "checking": return "Checking GitHub for a newer release…";
    case "available": return `Version ${version} is available.`;
    case "downloading": {
      const total = state.totalBytes ? ` of ${formatBytes(state.totalBytes)}` : "";
      return `Downloading ${version}… ${formatBytes(state.downloadedBytes ?? 0)}${total}`;
    }
    case "verifying": return `Checking the checksum, Developer ID signature, and notarization of ${version}…`;
    case "ready":
      return state.mode === "installer"
        ? `Version ${version} is verified. Duc's Table will quit, update, and reopen.`
        : `Version ${version} is downloaded and verified. Drag it to Applications, replacing this copy.`;
    case "installing": return `Installing ${version}…`;
    default: {
      if (!state.lastCheckedAt) return state.autoCheck ? "Duc's Table checks for updates shortly after launch." : "Automatic checks are off.";
      const checked = `Up to date · checked ${formatCheckedAgo(state.lastCheckedAt, now)}`;
      return state.skippedVersion ? `${checked} · ${state.skippedVersion} skipped` : checked;
    }
  }
}

export function formatCheckedAgo(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "recently";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
