import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, JobState } from "@/types";
import { JobsPanel } from "./JobsPanel";

afterEach(cleanup);

function job(state: JobState): Job {
  return {
    projectId: state === "queued" || state === "running" ? "current" : "other",
    id: `job-${state}`,
    kind: "import",
    state,
    sourceName: `${state} source`,
    stage: state === "running" ? "Reading rows" : undefined,
    message: state === "failed" ? "Could not parse file" : undefined,
    createdAt: "2026-08-20T10:00:00.000Z",
    startedAt: state === "queued" ? undefined : "2026-08-20T10:00:01.000Z",
    finishedAt: state === "queued" || state === "running" ? undefined : "2026-08-20T10:00:04.000Z",
  };
}

describe("JobsPanel", () => {
  it("renders every state and only cancels queued or running jobs", () => {
    const onCancel = vi.fn();
    const states: JobState[] = ["queued", "running", "completed", "failed", "cancelled"];
    render(<JobsPanel open onOpenChange={vi.fn()} jobs={states.map(job)} projects={[{ id: "current", name: "Current", description: "", lastOpenedAt: "", createdAt: "", updatedAt: "" }, { id: "other", name: "Other", description: "", lastOpenedAt: "", createdAt: "", updatedAt: "" }]} activeProjectId="current" onCancel={onCancel} />);

    const currentRegion = screen.getByRole("region", { name: "Current project jobs" });
    const otherRegion = screen.getByRole("region", { name: "Other projects jobs" });
    expect(currentRegion).toHaveTextContent("Current project · Current");
    expect(otherRegion).toHaveTextContent("Other projects");
    expect(within(currentRegion).getAllByText(/^import · Current$/i)).toHaveLength(2);
    expect(within(otherRegion).getAllByText(/^import · Other$/i)).toHaveLength(3);
    for (const state of states) expect(document.querySelector(`[data-job-state="${state}"]`)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Cancel / })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancel running source" }));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "job-running" }));
  });

  it("shows actionable import failure diagnostics", () => {
    const failed = job("failed");
    failed.error = {
      message: "The workbook is password protected.",
      details: {
        stage: "Opening workbook",
        suggestion: "Save an unprotected copy and retry.",
        errorRef: "bd260767-4112-465d-ae55-87d700e7866c",
        logPath: "/Users/example/Library/Logs/DUCS Table/app.log",
      },
    };
    render(<JobsPanel open onOpenChange={vi.fn()} jobs={[failed]} projects={[{ id: "other", name: "Other", description: "", lastOpenedAt: "", createdAt: "", updatedAt: "" }]} onCancel={vi.fn()} />);

    const row = document.querySelector('[data-job-state="failed"]');
    expect(row).toHaveTextContent("The workbook is password protected.");
    expect(row).toHaveTextContent("Stage: Opening workbook");
    expect(row).toHaveTextContent("Save an unprotected copy and retry.");
    expect(row).toHaveTextContent("Reference: bd260767");
    expect(row).toHaveTextContent("Log: /Users/example/Library/Logs/DUCS Table/app.log");
  });
});
