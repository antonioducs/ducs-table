import { create } from "zustand";
import { bridge, isBridgeAvailable } from "@/lib/bridge";
import type { UpdateState } from "@/types";

/**
 * Mirrors the Go update service. The backend owns every decision (schedule,
 * verification, install); this store only reflects state and forwards intent.
 */
interface UpdateStore {
  state?: UpdateState;
  initialize: () => () => void;
  apply: (state: UpdateState) => void;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
  setAutoCheck: (enabled: boolean) => Promise<void>;
  openRelease: () => Promise<void>;
  reveal: () => Promise<void>;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  state: undefined,
  initialize() {
    if (!isBridgeAvailable()) return () => undefined;
    const unsubscribe = bridge.on("ducs:update-status", (state) => get().apply(state));
    void bridge.UpdateGetState().then((state) => get().apply(state)).catch(() => undefined);
    return unsubscribe;
  },
  // Binding responses and events travel on different channels, so a response
  // can arrive after a newer event; the backend revision orders them.
  apply(next) {
    set((current) => (!current.state || next.revision >= current.state.revision ? { state: next } : current));
  },
  async check() { get().apply(await bridge.UpdateCheck()); },
  async download() { get().apply(await bridge.UpdateDownload()); },
  async install() { get().apply(await bridge.UpdateInstall()); },
  async skip() { get().apply(await bridge.UpdateSkip()); },
  async setAutoCheck(enabled) { get().apply(await bridge.UpdateSetAutoCheck(enabled)); },
  openRelease() { return bridge.UpdateOpenRelease(); },
  reveal() { return bridge.UpdateReveal(); },
}));
