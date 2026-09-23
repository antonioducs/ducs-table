import { describe, expect, it } from "vitest";
import { normalizeUpdateState } from "@/lib/bridge";
import {
  formatCheckedAgo,
  isUpdateBusy,
  updateNeedsAttention,
  updatePrimaryAction,
  updatePrimaryLabel,
  updateStatusLine,
  updateTriggerLabel,
} from "@/lib/update-status";
import type { UpdateState } from "@/types";

const base: UpdateState = { revision: 1, phase: "idle", mode: "installer", currentVersion: "0.1.2", autoCheck: true };

describe("update status presentation", () => {
  it("offers the action each mode can actually perform", () => {
    const available = { ...base, phase: "available" as const, availableVersion: "0.2.0" };
    expect(updatePrimaryAction(available)).toBe("download");
    expect(updatePrimaryAction({ ...available, mode: "manual" })).toBe("download");
    expect(updatePrimaryAction({ ...available, mode: "notify" })).toBe("open-release");
    expect(updatePrimaryLabel({ ...available, mode: "notify" })).toBe("Get 0.2.0 on GitHub");

    const ready = { ...available, phase: "ready" as const };
    expect(updatePrimaryAction(ready)).toBe("install");
    expect(updatePrimaryLabel(ready)).toBe("Restart to update");
    expect(updatePrimaryAction({ ...ready, mode: "manual" })).toBe("reveal");

    for (const phase of ["idle", "checking", "downloading", "verifying", "installing"] as const) {
      expect(updatePrimaryAction({ ...available, phase })).toBeUndefined();
    }
  });

  it("labels the status bar control by phase", () => {
    expect(updateTriggerLabel(base)).toBe("v0.1.2");
    expect(updateNeedsAttention(base)).toBe(false);
    const downloading = { ...base, phase: "downloading" as const, availableVersion: "0.2.0", progress: 41.7, downloadedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 };
    expect(updateTriggerLabel(downloading)).toBe("Downloading 41%");
    expect(updateNeedsAttention(downloading)).toBe(true);
    expect(isUpdateBusy(downloading)).toBe(true);
    expect(updateStatusLine(downloading)).toBe("Downloading 0.2.0… 1.00 MB of 4.00 MB");
    expect(updateTriggerLabel({ ...downloading, phase: "ready", mode: "manual" })).toBe("Update ready");
  });

  it("describes when the app last checked and what was skipped", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(updateStatusLine(base, now)).toBe("Duc's Table checks for updates shortly after launch.");
    expect(updateStatusLine({ ...base, autoCheck: false }, now)).toBe("Automatic checks are off.");
    expect(updateStatusLine({ ...base, lastCheckedAt: "2026-09-23T11:15:00Z", skippedVersion: "0.2.0" }, now)).toBe("Up to date · checked 45 min ago · 0.2.0 skipped");
    expect(formatCheckedAgo("2026-09-23T11:59:40Z", now)).toBe("just now");
    expect(formatCheckedAgo("2026-09-23T07:00:00Z", now)).toBe("5 h ago");
    expect(formatCheckedAgo("2026-09-21T12:00:00Z", now)).toBe("2 days ago");
    expect(formatCheckedAgo("not a date", now)).toBe("recently");
  });

  it("normalizes untrusted backend payloads", () => {
    expect(normalizeUpdateState({ revision: 7, phase: "ready", mode: "manual", currentVersion: "0.1.2", availableVersion: "0.2.0", progress: 100, autoCheck: false })).toEqual({
      revision: 7,
      phase: "ready",
      mode: "manual",
      modeReason: undefined,
      currentVersion: "0.1.2",
      availableVersion: "0.2.0",
      releaseUrl: undefined,
      publishedAt: undefined,
      downloadedBytes: undefined,
      totalBytes: undefined,
      progress: 100,
      lastCheckedAt: undefined,
      autoCheck: false,
      skippedVersion: undefined,
      error: undefined,
    });
    const garbage = normalizeUpdateState({ phase: "exploded", mode: "root", progress: "NaN" });
    expect(garbage).toEqual(expect.objectContaining({ revision: 0, phase: "idle", mode: "off", autoCheck: true, progress: undefined }));
  });
});
