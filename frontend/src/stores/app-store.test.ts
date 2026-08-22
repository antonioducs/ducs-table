import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./app-store";
import type { Job, SourceInfo } from "@/types";

const source: SourceInfo = {
  id: "customers-id",
  displayName: "Customers",
  tableName: "customers",
  kind: "csv",
  rowCount: 2,
  status: "ready",
  isEphemeral: false,
  columns: [{ name: "customer_id", type: "BIGINT", nullable: false, ordinal: 1 }],
};

const job: Job = {
  id: "job-id",
  kind: "import",
  state: "running",
  stage: "Materializing",
  createdAt: "2026-08-20T12:00:00Z",
};

describe("app store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().reset();
  });

  it("opens, selects and closes source tabs", () => {
    const state = useAppStore.getState();
    state.upsertSource(source);
    state.openTab(source.id);
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().activeTabId).toBe(`source:${source.id}`);

    useAppStore.getState().closeTab(`source:${source.id}`);
    expect(useAppStore.getState().tabs).toEqual([]);
    expect(useAppStore.getState().activeTabId).toBeUndefined();
  });

  it("upserts jobs without ever adding table rows to session state", () => {
    useAppStore.getState().upsertJob(job);
    useAppStore.getState().upsertJob({ ...job, state: "completed", progress: 1 });
    const state = useAppStore.getState();
    expect(state.jobs).toEqual([{ ...job, state: "completed", progress: 1 }]);
    expect("rows" in state).toBe(false);
    expect(JSON.stringify(state)).not.toContain("previewRows");
  });

  it("does not downgrade a ready source when a late preview event arrives", () => {
    useAppStore.getState().upsertSource(source);
    useAppStore.getState().upsertSource({ ...source, status: "preparing", previewRows: [{ customer_id: 1 }] });
    expect(useAppStore.getState().sources[0].status).toBe("ready");
    expect(useAppStore.getState().sources[0].previewRows).toBeUndefined();
  });
});

