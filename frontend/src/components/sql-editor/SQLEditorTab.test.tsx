import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SQLDocument } from "@/types";

vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange, onUpdate, className, ...props }: { value: string; onChange: (value: string) => void; onUpdate?: (update: unknown) => void; className?: string; [key: string]: unknown }) => (
    <div data-testid="codemirror-root" className={className}>
      <textarea
        aria-label={String(props["aria-label"] ?? "SQL query")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onSelect={(event) => {
          const target = event.currentTarget;
          const from = target.selectionStart;
          const to = target.selectionEnd;
          onUpdate?.({
            selectionSet: true,
            docChanged: false,
            state: {
              selection: { main: { from, to } },
              doc: { sliceString: (start: number, end: number) => target.value.slice(start, end) },
            },
          });
        }}
      />
    </div>
  ),
}));

import { SQLEditorTab } from "./SQLEditorTab";

const document: SQLDocument = { id: "doc-1", title: "Query 1", sql: "SELECT 1" };

const baseProps = {
  document,
  onChange: vi.fn(),
  onRun: vi.fn(),
  onSave: vi.fn(),
  running: false,
  sources: [],
};

describe("SQL editor tab", () => {
  it("runs with Cmd/Ctrl+Enter and saves with Cmd/Ctrl+S", async () => {
    const onRun = vi.fn();
    const onSave = vi.fn();
    render(<SQLEditorTab {...baseProps} onRun={onRun} onSave={onSave} />);
    const editor = screen.getByRole("textbox", { name: "SQL query Query 1" });
    await userEvent.type(editor, "{Meta>}{Enter}{/Meta}");
    await userEvent.type(editor, "{Control>}s{/Control}");
    expect(onRun).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("does not run while disabled but preserves the SQL text", async () => {
    const onRun = vi.fn();
    render(<SQLEditorTab {...baseProps} onRun={onRun} disabled disabledReason="Preparing data" />);
    expect(screen.getByRole("textbox", { name: "SQL query Query 1" })).toHaveValue("SELECT 1");
    expect(screen.getByRole("button", { name: /Run/i })).toBeDisabled();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByText("Preparing data")).toBeInTheDocument();
  });

  it("runs only the selected query when the document has multiple statements", async () => {
    const onRun = vi.fn();
    const sql = "SELECT 1;\n\nSELECT 2;";
    render(<SQLEditorTab {...baseProps} document={{ ...document, sql }} onRun={onRun} />);
    const editor = screen.getByRole("textbox", { name: "SQL query Query 1" }) as HTMLTextAreaElement;
    editor.setSelectionRange(11, sql.length);
    fireEvent.select(editor);

    await userEvent.click(screen.getByRole("button", { name: /Run selection/i }));

    expect(onRun).toHaveBeenCalledWith("SELECT 2;");
  });

  it("titles the editor as a single query workspace", () => {
    render(<SQLEditorTab {...baseProps} />);
    expect(screen.getByLabelText("SQL editor Query 1")).toBeInTheDocument();
    expect(screen.getByTestId("codemirror-root")).toHaveClass("ducs-sql-editor", "h-full", "min-h-0", "overflow-hidden");
    expect(screen.queryByRole("button", { name: "Run in tab" })).not.toBeInTheDocument();
  });

  it("formats the current DuckDB query from the toolbar", async () => {
    const onChange = vi.fn();
    render(<SQLEditorTab {...baseProps} document={{ ...document, sql: "select id,name from users where active=true" }} onChange={onChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Format" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("SELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  active = TRUE");
    });
  });

  it("copies the current query from the toolbar", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SQLEditorTab {...baseProps} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy query" }));

    expect(writeText).toHaveBeenCalledWith("SELECT 1");
  });

  it("shows a detailed multiline query error without truncating it", () => {
    const error = "[INVALID_QUERY] Binder Error: missing_total was not found\nCandidate bindings: total — Line 1, column 8";
    render(<SQLEditorTab {...baseProps} error={error} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Binder Error: missing_total was not found");
    expect(alert).toHaveTextContent("Candidate bindings: total");
    expect(alert.querySelector("span")).toHaveClass("whitespace-pre-wrap", "overflow-y-auto");
  });
});
