import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "@/lib/bridge";
import { useAIStore } from "./ai-store";

describe("AI store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAIStore.getState().clear();
    vi.restoreAllMocks();
  });

  it("loads project-scoped configuration and transcript without persisting it", async () => {
    vi.spyOn(bridge, "AIGetConfig").mockResolvedValue({ projectId: "p1", provider: "codex", model: "gpt-5", fastMode: false, consent: false });
    vi.spyOn(bridge, "AIListConversations").mockResolvedValue([{ id: "c1", projectId: "p1", title: "Secret chat", provider: "codex", model: "gpt-5", createdAt: "2026-01-01", updatedAt: "2026-01-01" }]);
    const providerStatus = vi.spyOn(bridge, "AIProviderStatus").mockImplementation(async (provider) => ({ provider, available: true, authenticated: true }));
    const providerModels = vi.spyOn(bridge, "AIProviderListModels").mockImplementation(async (provider) => provider === "codex"
      ? [{ id: "gpt-5", name: "GPT 5" }]
      : [{ id: "claude-opus", name: "Claude Opus" }]);
    vi.spyOn(bridge, "AIGetConversation").mockResolvedValue({ conversation: { id: "c1", projectId: "p1", title: "Secret chat", provider: "codex", model: "gpt-5", createdAt: "2026-01-01", updatedAt: "2026-01-01" }, messages: [{ id: "m1", conversationId: "c1", sequence: 1, role: "user", content: "private transcript", status: "complete", createdAt: "", updatedAt: "" }] });

    await useAIStore.getState().initializeProject("p1");

    expect(useAIStore.getState().messagesByConversation.c1[0].content).toBe("private transcript");
    expect(providerStatus).toHaveBeenCalledWith("codex");
    expect(providerStatus).toHaveBeenCalledWith("claude");
    expect(providerModels).toHaveBeenCalledWith("codex");
    expect(providerModels).toHaveBeenCalledWith("claude");
    expect(useAIStore.getState().modelsByProvider.claude?.[0].id).toBe("claude-opus");
    expect(localStorage.length).toBe(0);
  });

  it("assembles streamed text, reasoning, and tool activity", () => {
    const base = { runId: "r1", projectId: "p1", conversationId: "c1", messageId: "m1", chatId: "chat", provider: "codex" as const };
    useAIStore.getState().handleStream({ ...base, event: { type: "text_delta", text: "Hello" } });
    useAIStore.getState().handleStream({ ...base, event: { type: "reasoning_delta", text: "Because" } });
    useAIStore.getState().handleStream({ ...base, event: { type: "tool_start", toolCallId: "t1", name: "propose_sql", input: { sql: "select 1" } } });
    useAIStore.getState().handleStream({ ...base, event: { type: "tool_result", toolCallId: "t1", output: { sql: "select 1" } } });
    useAIStore.getState().handleStream({ ...base, event: { type: "completed" } });

    expect(useAIStore.getState().messagesByConversation.c1[0]).toEqual(expect.objectContaining({ content: "Hello", reasoning: "Because", status: "complete" }));
    expect(useAIStore.getState().toolsByConversation.c1[0]).toEqual(expect.objectContaining({ name: "propose_sql", status: "complete", output: { sql: "select 1" } }));
  });

  it("restores persisted preview tool events from message metadata", async () => {
    vi.spyOn(bridge, "AIGetConversation").mockResolvedValue({
      conversation: { id: "c1", projectId: "p1", title: "Analysis", provider: "codex", model: "gpt-5", createdAt: "", updatedAt: "" },
      messages: [{
        id: "m1", conversationId: "c1", sequence: 1, role: "assistant", content: "Done", status: "complete", createdAt: "", updatedAt: "",
        metadata: { events: [
          { type: "tool_start", toolCallId: "t1", name: "preview_query", input: { sql: "select 1" } },
          { type: "tool_result", toolCallId: "t1", output: { columns: ["value"], rows: [{ value: 1 }], truncated: false, bytes: 32 } },
        ] },
      }],
    });

    await useAIStore.getState().selectConversation("p1", "c1");

    expect(useAIStore.getState().toolsByConversation.c1[0]).toEqual(expect.objectContaining({
      name: "preview_query",
      status: "complete",
      output: { columns: ["value"], rows: [{ value: 1 }], truncated: false, bytes: 32 },
    }));
  });
});
