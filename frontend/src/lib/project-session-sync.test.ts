import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { flushProjectSession, markProjectSessionSaved, resetProjectSessionSync, scheduleProjectSessionSave } from "./project-session-sync";
import type { ProjectSession } from "@/types";

const session = (sql: string): ProjectSession => ({
  version: 2,
  documents: [{ id: "doc-1", title: "Query 1", sql }],
  tabs: [{ id: "tab-1", kind: "sql", title: "Query 1", documentId: "doc-1" }],
  groups: [{ id: "group-1", tabIds: ["tab-1"], activeTabId: "tab-1" }],
  layout: { kind: "group", groupId: "group-1", size: 100 },
  activeGroupId: "group-1",
  history: [],
  resultSequence: 0,
});

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
    expect(save).toHaveBeenCalledWith({ projectId: "project-1", session: expect.objectContaining({ documents: [expect.objectContaining({ sql: "select 2" })] }) });
  });

  it("flushes the latest store snapshot even before a debounce effect queues it", async () => {
    const save = vi.spyOn(bridge, "SaveProjectSession").mockResolvedValue();
    markProjectSessionSaved("project-1", session("old"));
    await flushProjectSession("project-1", session("latest"));
    expect(save).toHaveBeenCalledWith({ projectId: "project-1", session: expect.objectContaining({ documents: [expect.objectContaining({ sql: "latest" })] }) });
  });
});
