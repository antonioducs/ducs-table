import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AIComposer } from "./AIComposer";
import { aiEffortOptions } from "./ai-model-capabilities";

describe("AIComposer controls", () => {
  it("derives model effort options from provider metadata", () => {
    expect(aiEffortOptions({ id: "gpt", name: "GPT", raw: { supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] } }, "codex")).toEqual(["low", "high"]);
    expect(aiEffortOptions({ id: "claude", name: "Claude", raw: { supportsEffort: false } }, "claude")).toEqual([]);
  });

  it("shows model, effort and Fast controls inline", () => {
    const onFast = vi.fn();
    render(<AIComposer
      config={{ projectId: "p1", provider: "codex", model: "gpt", reasoningEffort: "high", fastMode: false, consent: true }}
      models={[{ provider: "codex", model: { id: "gpt", name: "GPT" } }]}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastModeChange={onFast}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />);
    expect(screen.getByRole("combobox", { name: "AI effort" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Composer AI model" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fast mode" }));
    expect(onFast).toHaveBeenCalledWith(true);
  });

  it("lists both providers and selects provider and model together", () => {
    const onModelChange = vi.fn();
    render(<AIComposer
      disabled
      modelSelectionDisabled={false}
      config={{ projectId: "p1", provider: "codex", model: "shared", fastMode: false, consent: true }}
      models={[
        { provider: "codex", model: { id: "shared", name: "GPT Shared" } },
        { provider: "claude", model: { id: "shared", name: "Claude Shared" } },
      ]}
      onModelChange={onModelChange}
      onEffortChange={vi.fn()}
      onFastModeChange={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />);

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Composer AI model" }), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Codex · GPT Shared" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Claude · Claude Shared" }));
    expect(onModelChange).toHaveBeenCalledWith("claude", "shared");
  });
});
