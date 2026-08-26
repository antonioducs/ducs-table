import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge, normalizeAIConfig, normalizeAIConversation, normalizeAIMessage, normalizeAIModel, normalizeAIProviderStatus, normalizeAIRun, normalizeAppError, normalizePreviewSource, normalizeProjectSession, normalizeProjectWorkspace, normalizeSource } from "./bridge";

afterEach(() => {
  delete window.go;
  delete window.runtime;
});

describe("project bridge normalization", () => {
  it("preserves actionable AppError details from either JSON naming convention", () => {
    expect(normalizeAppError({
      Code: "IMPORT_FAILED",
      Message: "The workbook could not be read.",
      Details: { stage: "Opening workbook", suggestion: "Close the file and retry.", errorRef: "2ac47cf0-2d97-4ad0-863c-b625ea15d056", logPath: "/tmp/ducs.log" },
    })).toEqual({
      code: "IMPORT_FAILED",
      message: "The workbook could not be read.",
      details: { stage: "Opening workbook", suggestion: "Close the file and retry.", errorRef: "2ac47cf0-2d97-4ad0-863c-b625ea15d056", logPath: "/tmp/ducs.log" },
    });
  });

  it("normalizes AppError details on both import failure events", () => {
    const handlers: Record<string, (payload: unknown) => void> = {};
    Object.defineProperty(window, "runtime", { configurable: true, value: { EventsOn: (name: string, callback: (payload: unknown) => void) => { handlers[name] = callback; } } });
    const datasetFailed = vi.fn();
    const jobUpdated = vi.fn();
    bridge.on("ducs:dataset-failed", datasetFailed);
    bridge.on("ducs:job-updated", jobUpdated);
    const error = { code: "IMPORT_FAILED", message: "Invalid CSV row.", details: { suggestion: "Retry with malformed rows skipped.", errorRef: "90f1928e-acde" } };

    handlers["ducs:dataset-failed"]({ projectId: "project-1", sourceId: "source-1", error });
    handlers["ducs:job-updated"]({ projectId: "project-1", sourceId: "source-1", id: "job-1", kind: "import", state: "failed", error });

    expect(datasetFailed).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: error.details }) }));
    expect(jobUpdated).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: error.details }) }));
  });

  it("drops blank paths from native file-drop events", () => {
    const handlers: Record<string, (payload: unknown) => void> = {};
    Object.defineProperty(window, "runtime", { configurable: true, value: { EventsOn: (name: string, callback: (payload: unknown) => void) => { handlers[name] = callback; } } });
    const dropped = vi.fn();
    bridge.on("ducs:file-drop", dropped);

    handlers["ducs:file-drop"]({ paths: ["", "   ", "/tmp/orders.csv"] });

    expect(dropped).toHaveBeenCalledWith({ projectId: undefined, paths: ["/tmp/orders.csv"] });
  });

  it("maps backend SourceInfo fields while keeping preview rows transient", () => {
    const source = normalizeSource({
      id: "source-1", projectId: "project-1", displayName: "Orders", sqlName: "orders", sourceType: "csv", rowCount: 4, isEphemeral: false,
      columns: [], originalSql: "select * from orders", previewRows: [{ id: 1 }],
    });
    expect(source).toEqual(expect.objectContaining({ projectId: "project-1", tableName: "orders", kind: "csv", originalSQL: "select * from orders" }));
    expect(source.previewRows).toEqual([{ id: 1 }]);
    expect(normalizePreviewSource({ ...source, previewRows: [{ id: 1 }] }).previewRows).toEqual([{ id: 1 }]);
  });

  it("sanitizes backend sessions and preloads external workspace catalogs", () => {
    const session = normalizeProjectSession({
      version: 2,
      documents: [{ id: "doc-1", title: "Query 1", sql: "select 1" }],
      tabs: [
        { id: "external:one", kind: "external", relationId: "one", title: "Orders" },
        { id: "sql:one", kind: "sql", title: "Query 1", documentId: "doc-1" },
      ],
      groups: [{ id: "group-a", tabIds: ["external:one"], activeTabId: "missing" }],
      layout: { kind: "split", direction: "vertical", children: [{ kind: "group", groupId: "group-a" }, { kind: "group", groupId: "gone" }] },
      activeGroupId: "gone",
      history: Array.from({ length: 24 }, (_, index) => ({ id: String(index), sql: `select ${index}`, ranAt: "", status: "success" as const })),
      resultSequence: 2,
    });
    expect(session.history).toHaveLength(20);
    // Unknown groups are dropped and the orphan SQL tab is adopted so nothing is lost.
    expect(session.groups).toHaveLength(1);
    expect(session.groups[0].tabIds).toEqual(["external:one", "sql:one"]);
    expect(session.groups[0].activeTabId).toBe("sql:one");
    expect(session.layout).toEqual({ kind: "group", groupId: "group-a", size: 100 });
    expect(session.activeGroupId).toBe("group-a");

    const workspace = normalizeProjectWorkspace({
      project: { id: "project-1", name: "Analytics", description: "", lastOpenedAt: "", createdAt: "", updatedAt: "" },
      sources: [], savedQueries: [], connections: [], session,
      externalRelations: [{ id: "one", connectionId: "conn", provider: "postgres", catalog: "prod", schema: "public", name: "orders", relationType: "table", qualifiedName: '"prod"."public"."orders"', columns: [], defaultOrder: [], pagingStable: false }],
    });
    expect(workspace.externalRelations).toHaveLength(1);
    expect(workspace.project.id).toBe("project-1");
  });
});

describe("AI bridge normalization", () => {
  it("accepts PascalCase, snake_case, legacy model keys, and encoded metadata", () => {
    expect(normalizeAIConfig({ ProjectID: "p1", Provider: "claude", Model: "opus", ReasoningEffort: "high", FastMode: true, Consent: true })).toEqual({ projectId: "p1", provider: "claude", model: "opus", reasoningEffort: "high", fastMode: true, consent: true });
    expect(normalizeAIProviderStatus({ Provider: "codex", Available: true, Authenticated: true }, "claude")).toEqual(expect.objectContaining({ provider: "codex", available: true, authenticated: true }));
    expect(normalizeAIModel({ slug: "gpt-5", display_name: "GPT 5" })).toEqual(expect.objectContaining({ id: "gpt-5", name: "GPT 5" }));
    expect(normalizeAIConversation({ ID: "c1", ProjectID: "p1", Provider: "claude", Model: "opus", CreatedAt: "now" })).toEqual(expect.objectContaining({ id: "c1", projectId: "p1", provider: "claude" }));
    expect(normalizeAIMessage({ ID: "m1", ConversationID: "c1", Role: "assistant", Status: "streaming", Metadata: "{\"safe\":true}" })).toEqual(expect.objectContaining({ id: "m1", status: "streaming", metadata: { safe: true } }));
    expect(normalizeAIRun({ ID: "r1", ConversationID: "c1", AssistantMessageID: "m1", State: "running" })).toEqual(expect.objectContaining({ id: "r1", conversationId: "c1", assistantMessageId: "m1" }));
  });

  it("calls every AI desktop contract and normalizes responses", async () => {
    const conversation = { ID: "c1", ProjectID: "p1", Title: "Chat", Provider: "codex", Model: "gpt-5", CreatedAt: "a", UpdatedAt: "b" };
    const api = {
      AIGetConfig: vi.fn().mockResolvedValue({ ProjectID: "p1", Provider: "codex", Model: "gpt-5" }),
      AIProviderStatus: vi.fn().mockResolvedValue({ Provider: "codex", Available: true, Authenticated: true }),
      AIProviderLogin: vi.fn().mockResolvedValue({ started: true }),
      AIProviderLogout: vi.fn().mockResolvedValue(undefined),
      AIProviderListModels: vi.fn().mockResolvedValue([{ slug: "gpt-5", label: "GPT 5" }]),
      AIListConversations: vi.fn().mockResolvedValue([conversation]),
      AICreateConversation: vi.fn().mockResolvedValue(conversation),
      AIGetConversation: vi.fn().mockResolvedValue({ Conversation: conversation, Messages: [] }),
      AIDeleteConversation: vi.fn().mockResolvedValue(undefined),
      AISend: vi.fn().mockResolvedValue({ ID: "r1", ProjectID: "p1", ConversationID: "c1", AssistantMessageID: "m1", State: "running" }),
      AIStop: vi.fn().mockResolvedValue({ ID: "r1", ProjectID: "p1", ConversationID: "c1", AssistantMessageID: "m1", State: "cancelled" }),
      AIRespondApproval: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(window, "go", { configurable: true, value: { main: { App: api } } });

    expect(await bridge.AIGetConfig("p1")).toEqual(expect.objectContaining({ projectId: "p1", model: "gpt-5" }));
    expect(await bridge.AIProviderStatus("codex")).toEqual(expect.objectContaining({ authenticated: true }));
    await bridge.AIProviderLogin("codex"); await bridge.AIProviderLogout("codex");
    expect(await bridge.AIProviderListModels("codex")).toEqual([expect.objectContaining({ id: "gpt-5", name: "GPT 5" })]);
    expect(await bridge.AIListConversations("p1")).toEqual([expect.objectContaining({ id: "c1" })]);
    expect(await bridge.AICreateConversation({ projectId: "p1", provider: "codex", model: "gpt-5" })).toEqual(expect.objectContaining({ id: "c1" }));
    expect(await bridge.AIGetConversation({ projectId: "p1", conversationId: "c1" })).toEqual(expect.objectContaining({ messages: [] }));
    await bridge.AIDeleteConversation({ projectId: "p1", conversationId: "c1" });
    expect(await bridge.AISend({ projectId: "p1", conversationId: "c1", prompt: "Hi" })).toEqual(expect.objectContaining({ id: "r1", state: "running" }));
    expect(await bridge.AIStop({ projectId: "p1", runId: "r1" })).toEqual(expect.objectContaining({ state: "cancelled" }));
    await bridge.AIRespondApproval({ approvalId: "a1", decision: "allow_once" });
    expect(api.AIRespondApproval).toHaveBeenCalledWith({ approvalId: "a1", decision: "allow_once" });
  });

  it("normalizes AI stream events emitted with Go field names", () => {
    const handlers: Record<string, (payload: unknown) => void> = {};
    Object.defineProperty(window, "runtime", { configurable: true, value: { EventsOn: (name: string, callback: (payload: unknown) => void) => { handlers[name] = callback; } } });
    const listener = vi.fn();
    bridge.on("ducs:ai-stream", listener);
    handlers["ducs:ai-stream"]({ RunID: "r1", ProjectID: "p1", ConversationID: "c1", MessageID: "m1", Provider: "claude", Event: { Type: "text_delta", Text: "hello" } });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1", provider: "claude", event: expect.objectContaining({ type: "text_delta", text: "hello" }) }));
  });
});
