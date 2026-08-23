import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AIMessageList } from "./AIMessageList";

describe("AIMessageList", () => {
  it("sanitizes markdown and exposes SQL actions", () => {
    const onReplace = vi.fn();
    const message = { id: "m1", conversationId: "c1", sequence: 1, role: "assistant" as const, content: "Hello <script>alert(1)</script>\n```sql\nselect * from orders\n```", status: "complete" as const, createdAt: "", updatedAt: "" };
    const { container } = render(<AIMessageList messages={[message]} tools={[]} approvals={[]} onApproval={vi.fn()} onReplace={onReplace} onAppend={vi.fn()} onExecute={vi.fn()} />);

    expect(container.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Replace SQL editor" }));
    expect(onReplace).toHaveBeenCalledWith("select * from orders");
  });

  it("renders approvals as explicit allow/deny decisions", () => {
    const onApproval = vi.fn();
    const approval = { id: "a1", projectId: "p1", conversationId: "c1", runId: "r1", toolCallId: "t1", tool: "preview_query", summary: "Preview this query", input: {}, createdAt: "" };
    render(<AIMessageList messages={[]} tools={[]} approvals={[approval]} onApproval={onApproval} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow for this conversation" }));
    expect(onApproval).toHaveBeenCalledWith(approval, "allow_conversation");
  });

  it("renders persisted preview output as a compact data table", () => {
    const message = { id: "m1", conversationId: "c1", sequence: 1, role: "assistant" as const, content: "Observed results", status: "complete" as const, createdAt: "", updatedAt: "" };
    const tool = {
      toolCallId: "t1", messageId: "m1", name: "preview_query", status: "complete" as const,
      input: { sql: "select customer, total from orders" },
      output: { columns: ["customer", "total"], rows: [{ customer: "Ada", total: 42 }, { customer: "Lin", total: null }], truncated: true, bytes: 1536 },
    };
    render(<AIMessageList messages={[message]} tools={[tool]} approvals={[]} onApproval={vi.fn()} onReplace={vi.fn()} onAppend={vi.fn()} onExecute={vi.fn()} />);

    expect(screen.getByRole("table", { name: "Query preview data" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "customer" })).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("NULL")).toBeInTheDocument();
    expect(screen.getByText("Preview truncated")).toBeInTheDocument();
    expect(screen.getByText("1.5 KiB")).toBeInTheDocument();
    expect(screen.queryByText("Tool output")).not.toBeInTheDocument();
  });
});
