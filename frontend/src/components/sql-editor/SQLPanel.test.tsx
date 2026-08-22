import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange, ...props }: { value: string; onChange: (value: string) => void; [key: string]: unknown }) => (
    <textarea aria-label={String(props["aria-label"] ?? "SQL query")} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { SQLPanel } from "./SQLPanel";

const baseProps = {
  value: "SELECT 1",
  onChange: vi.fn(),
  onRun: vi.fn(),
  onNew: vi.fn(),
  onSave: vi.fn(),
  running: false,
  sources: [],
};

describe("SQL panel shortcuts", () => {
  it("runs with Cmd/Ctrl+Enter and saves with Cmd/Ctrl+S", async () => {
    const onRun = vi.fn();
    const onSave = vi.fn();
    render(<SQLPanel {...baseProps} onRun={onRun} onSave={onSave} />);
    const editor = screen.getByRole("textbox", { name: "SQL query" });
    await userEvent.type(editor, "{Meta>}{Enter}{/Meta}");
    await userEvent.type(editor, "{Control>}s{/Control}");
    expect(onRun).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("does not run while disabled but preserves the SQL text", async () => {
    const onRun = vi.fn();
    render(<SQLPanel {...baseProps} onRun={onRun} disabled disabledReason="Preparing data" />);
    expect(screen.getByRole("textbox", { name: "SQL query" })).toHaveValue("SELECT 1");
    expect(screen.getByRole("button", { name: /Run/i })).toBeDisabled();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByText("Preparing data")).toBeInTheDocument();
  });
});

