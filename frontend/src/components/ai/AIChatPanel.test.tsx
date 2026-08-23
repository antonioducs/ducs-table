import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAIStore } from "@/stores/ai-store";
import { AIChatPanel } from "./AIChatPanel";

describe("AIChatPanel consent", () => {
  beforeEach(() => {
    localStorage.clear();
    useAIStore.getState().clear();
    useAIStore.setState({
      configByProject: { p1: { projectId: "p1", provider: "codex", model: "gpt-5", fastMode: false, consent: false } },
      providerStatus: { codex: { provider: "codex", available: true, authenticated: true } },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("requires explicit consent before the first send", async () => {
    vi.spyOn(useAIStore.getState(), "initializeProject").mockResolvedValue();
    const send = vi.spyOn(useAIStore.getState(), "send").mockResolvedValue();
    render(<AIChatPanel projectId="p1" projectName="Analytics" sourceName="Orders" onClose={vi.fn()} onReplaceSQL={vi.fn()} onAppendSQL={vi.fn()} onExecuteSQL={vi.fn()} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message AI" }), { target: { value: "Summarize orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Allow AI for this workspace?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "I understand, send" }));
    expect(send).toHaveBeenCalledWith("p1", "Summarize orders", "project Analytics; active source Orders", true);
    expect(localStorage.length).toBe(0);
  });
});
