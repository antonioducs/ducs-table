import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, JobState } from "@/types";
import { JobsPanel } from "./JobsPanel";

afterEach(cleanup);

function job(state: JobState): Job {
  return {
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
    render(<JobsPanel open onOpenChange={vi.fn()} jobs={states.map(job)} onCancel={onCancel} />);

    for (const state of states) expect(document.querySelector(`[data-job-state="${state}"]`)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Cancel / })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancel running source" }));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "job-running" }));
  });
});
