import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SourceInfo } from "@/types";
import { EmptyState } from "./EmptyState";
import { RetryImportDialog, SheetPicker } from "./ImportDialogs";
import { SourceStateBanner, SourceStateOverlay, type SourceViewState } from "./ImportStatusBanner";

afterEach(cleanup);
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterAll(() => vi.unstubAllGlobals());

function source(status: SourceInfo["status"], rowCount: number | null = null): SourceInfo {
  return {
    projectId: "project-1",
    id: "source-1",
    displayName: "orders.csv",
    tableName: "orders",
    kind: "csv",
    rowCount,
    status,
    isEphemeral: false,
    columns: [],
    error: status === "failed" ? { message: "Malformed row" } : undefined,
  };
}

describe("import presentation", () => {
  it("renders the exact empty-state copy and green drag feedback", () => {
    const onChoose = vi.fn();
    const { rerender } = render(<EmptyState onChoose={onChoose} projectName="Analytics" />);
    expect(screen.getByText("Drop a data file anywhere")).toBeInTheDocument();
    expect(screen.getByText("CSV, TSV, JSON, JSONL or XLSX — processed locally")).toBeInTheDocument();
    expect(screen.getByText("Add the first source to Analytics.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open data file" }));
    expect(onChoose).toHaveBeenCalledOnce();

    rerender(<EmptyState onChoose={onChoose} projectName="Analytics" dragActive />);
    expect(screen.getByText("Release to import files")).toHaveClass("text-primary");
  });

  it.each<[SourceViewState, SourceInfo, string]>([
    ["preview", source("preview"), "Preview available"],
    ["preparing", source("preparing"), "Preparing for fast queries…"],
    ["failed", source("failed"), "Import failed"],
    ["cancelled", source("cancelled"), "Import cancelled"],
    ["no-results", source("ready", 0), "No results"],
  ])("renders the %s source state", (state, value, title) => {
    const { container } = render(<SourceStateOverlay source={value} elapsed="12s" />);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(container.querySelector(`[data-source-state="${state}"]`)).toBeInTheDocument();
  });

  it("exposes cancel and retry actions", () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(<SourceStateBanner source={source("preparing")} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(<SourceStateBanner source={source("failed")} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry options" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("confirms one workbook sheet", () => {
    const onConfirm = vi.fn();
    render(<SheetPicker workbook={{ projectId: "project-1", path: "/tmp/book.xlsx", displayName: "book.xlsx", sheets: ["Orders", "Customers"] }} open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("radio", { name: /Customers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import sheet" }));
    expect(onConfirm).toHaveBeenCalledWith("Customers");
  });

  it("hides delimiter and malformed-row options for XLSX retries", () => {
    render(<RetryImportDialog open onOpenChange={vi.fn()} kind="xlsx" onConfirm={vi.fn()} />);
    expect(screen.queryByLabelText("Delimiter")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Skip malformed rows" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "First row is a header" })).toBeInTheDocument();
  });

  it("returns the selected delimited-file retry options", () => {
    const onConfirm = vi.fn();
    render(<RetryImportDialog open onOpenChange={vi.fn()} kind="csv" options={{ delimiter: ";" }} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Read every column as text" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Skip malformed rows" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry import" }));
    expect(onConfirm).toHaveBeenCalledWith({ delimiter: ";", header: true, allVarchar: true, ignoreErrors: true });
  });
});
