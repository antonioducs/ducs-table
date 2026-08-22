import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { flushProjectSession, markProjectSessionSaved, resetProjectSessionSync, scheduleProjectSessionSave } from "./project-session-sync";
import type { ProjectSession } from "@/types";

const session = (sqlDraft: string): ProjectSession => ({ version: 1, sqlDraft, tabs: [], history: [], resultSequence: 0 });

afterEach(() => {
  resetProjectSessionSync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("project session persistence", () => {
  it("debounces for roughly 500ms and keeps only the latest project draft", async () => {
    vi.useFakeTimers();
    const save = vi.spyOn(bridge, "SaveProjectSession").mockResolvedValue();
    markProjectSessionSaved("project-1", session(""));
    scheduleProjectSessionSave("project-1", session("select 1"));
    scheduleProjectSessionSave("project-1", session("select 2"));
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ projectId: "project-1", session: expect.objectContaining({ sqlDraft: "select 2" }) });
  });

  it("flushes the latest store snapshot even before a debounce effect queues it", async () => {
    const save = vi.spyOn(bridge, "SaveProjectSession").mockResolvedValue();
    markProjectSessionSaved("project-1", session("old"));
    await flushProjectSession("project-1", session("latest"));
    expect(save).toHaveBeenCalledWith({ projectId: "project-1", session: expect.objectContaining({ sqlDraft: "latest" }) });
  });
});
