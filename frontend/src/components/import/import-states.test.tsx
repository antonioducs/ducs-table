import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";
import { ImportStatusBanner } from "./ImportStatusBanner";
import type { SourceInfo } from "@/types";

const source: SourceInfo = {
  id: "source",
  displayName: "Customers",
  tableName: "customers",
  kind: "csv",
  rowCount: null,
  status: "preparing",
  isEphemeral: false,
  columns: [{ name: "id", type: "BIGINT", nullable: false, ordinal: 1 }],
  previewRows: [{ id: 1 }],
};

describe("import states", () => {
  it("renders the useful local-first empty state", async () => {
    const choose = vi.fn();
    render(<EmptyState onChoose={choose} />);
    expect(screen.getByText("Drop a data file anywhere")).toBeInTheDocument();
    expect(screen.getByText("CSV, TSV, JSON, JSONL or XLSX — processed locally")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose files" }));
    expect(choose).toHaveBeenCalledOnce();
  });

  it("distinguishes preparing and recoverable failure states", () => {
    const { rerender } = render(<ImportStatusBanner source={source} />);
    expect(screen.getByText("Preparing for fast queries…")).toBeInTheDocument();
    rerender(<ImportStatusBanner source={{ ...source, status: "failed", error: { message: "Delimiter could not be detected" } }} onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Delimiter could not be detected");
    expect(screen.getByRole("button", { name: /Retry options/i })).toBeInTheDocument();
  });
});

