import { describe, expect, it } from "vitest";
import { appErrorToastDescription, ImportFailureToastDeduper, presentAppError, shortErrorReference } from "./app-error";

describe("AppError presentation", () => {
  it("uses the safe message and actionable import details", () => {
    const error = presentAppError({
      code: "IMPORT_FAILED",
      message: "The CSV contains an invalid quoted field.",
      details: {
        stage: "Reading CSV rows",
        suggestion: "Check the delimiter and quote settings, then retry.",
        errorRef: "7ad7cc9e-61b4-4b56-a2f0-341aaf244454",
        logPath: "/Users/example/Library/Logs/DUCS Table/app.log",
      },
    }, "Import failed");

    expect(error).toEqual({
      message: "The CSV contains an invalid quoted field.",
      stage: "Reading CSV rows",
      suggestion: "Check the delimiter and quote settings, then retry.",
      errorRef: "7ad7cc9e-61b4-4b56-a2f0-341aaf244454",
      shortErrorRef: "7ad7cc9e",
      logPath: "/Users/example/Library/Logs/DUCS Table/app.log",
    });
    expect(appErrorToastDescription(error)).toBe("Check the delimiter and quote settings, then retry. · Stage: Reading CSV rows · Reference: 7ad7cc9e · Log: /Users/example/Library/Logs/DUCS Table/app.log");
  });

  it("keeps an already-short error reference intact and falls back safely", () => {
    expect(shortErrorReference("IMP-42A7")).toBe("IMP-42A7");
    expect(presentAppError(undefined, "The import failed.", "Materializing")).toEqual({
      message: "The import failed.",
      stage: "Materializing",
      suggestion: undefined,
      errorRef: undefined,
      shortErrorRef: undefined,
      logPath: undefined,
    });
  });
});

describe("import failure toast deduplication", () => {
  it("notifies once whether dataset-failed or job-updated arrives first", () => {
    const datasetFirst = new ImportFailureToastDeduper();
    expect(datasetFirst.shouldNotify("project-1", "source-1")).toBe(true);
    expect(datasetFirst.shouldNotify("project-1", "source-1")).toBe(false);

    const jobFirst = new ImportFailureToastDeduper();
    expect(jobFirst.shouldNotify("project-1", "source-1")).toBe(true);
    expect(jobFirst.shouldNotify("project-1", "source-1")).toBe(false);
  });

  it("allows a notification after the source starts a new import lifecycle", () => {
    const deduper = new ImportFailureToastDeduper();
    expect(deduper.shouldNotify("project-1", "source-1")).toBe(true);
    deduper.reset("project-1", "source-1");
    expect(deduper.shouldNotify("project-1", "source-1")).toBe(true);
    expect(deduper.shouldNotify("project-2", "source-1")).toBe(true);
  });
});
