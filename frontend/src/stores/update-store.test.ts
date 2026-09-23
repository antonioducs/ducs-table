import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "@/lib/bridge";
import type { UpdateState } from "@/types";
import { useUpdateStore } from "./update-store";

const state = (revision: number, patch: Partial<UpdateState> = {}): UpdateState => ({
  revision,
  phase: "idle",
  mode: "installer",
  currentVersion: "0.1.2",
  autoCheck: true,
  ...patch,
});

describe("update store", () => {
  beforeEach(() => {
    useUpdateStore.setState({ state: undefined });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete window.go;
    delete window.runtime;
  });

  it("ignores binding responses older than events already received", async () => {
    useUpdateStore.getState().apply(state(5, { phase: "ready", availableVersion: "0.2.0" }));
    vi.spyOn(bridge, "UpdateDownload").mockResolvedValue(state(3, { phase: "downloading", availableVersion: "0.2.0" }));

    await useUpdateStore.getState().download();

    expect(useUpdateStore.getState().state).toEqual(expect.objectContaining({ revision: 5, phase: "ready" }));
  });

  it("subscribes to backend events and loads the current state", async () => {
    let listener: ((payload: unknown) => void) | undefined;
    const off = vi.fn();
    window.go = { main: { App: { UpdateGetState: vi.fn().mockResolvedValue(state(2, { phase: "available", availableVersion: "0.2.0" })) } } } as unknown as Window["go"];
    window.runtime = {
      EventsOn: vi.fn((name: string, callback: (payload: unknown) => void) => {
        if (name === "ducs:update-status") listener = callback;
        return off;
      }),
    };

    const unsubscribe = useUpdateStore.getState().initialize();
    await vi.waitFor(() => expect(useUpdateStore.getState().state?.phase).toBe("available"));
    listener?.({ revision: 3, phase: "downloading", mode: "installer", currentVersion: "0.1.2", availableVersion: "0.2.0", progress: 12, autoCheck: true });
    expect(useUpdateStore.getState().state).toEqual(expect.objectContaining({ phase: "downloading", progress: 12 }));

    unsubscribe();
    expect(off).toHaveBeenCalledOnce();
  });

  it("does nothing outside the desktop bridge", () => {
    const unsubscribe = useUpdateStore.getState().initialize();
    unsubscribe();
    expect(useUpdateStore.getState().state).toBeUndefined();
  });
});
