import { afterEach, describe, expect, it, vi } from "vitest";
import { installWailsErrorNormalizer, normalizeWailsCallbackPayload } from "./wails-error-normalizer";

describe("Wails error normalizer", () => {
  afterEach(() => { delete window.wails; });

  it("turns a structured AppError into an actionable runtime message", () => {
    const normalized = JSON.parse(normalizeWailsCallbackPayload(JSON.stringify({ callbackid:"1", error:{ code:"CONNECTION_FAILED", message:"PostgreSQL refused the connection." } })));
    expect(normalized.error).toBe("[CONNECTION_FAILED] PostgreSQL refused the connection.");
  });

  it("leaves successful callback payloads unchanged", () => {
    const payload=JSON.stringify({callbackid:"1",result:{ok:true}});
    expect(normalizeWailsCallbackPayload(payload)).toBe(payload);
  });

  it("also decodes a JSON-encoded structured error", () => {
    const normalized=JSON.parse(normalizeWailsCallbackPayload(JSON.stringify({callbackid:"1",error:JSON.stringify({code:"CONNECTION_FAILED",message:"Connection timed out."})})));
    expect(normalized.error).toBe("[CONNECTION_FAILED] Connection timed out.");
  });

  it("keeps actionable details when Wails has to turn AppError into a string", () => {
    const normalized = JSON.parse(normalizeWailsCallbackPayload(JSON.stringify({ callbackid: "1", error: {
      code: "IMPORT_FAILED",
      message: "The CSV could not be parsed.",
      details: { stage: "Reading CSV rows", suggestion: "Check the delimiter and retry.", errorRef: "7685cb64-a28c-41fa-80f7-dd52a0f3a74d", logPath: "/tmp/ducs.log" },
    } })));
    expect(normalized.error).toBe("[IMPORT_FAILED] The CSV could not be parsed. — Check the delimiter and retry. · Stage: Reading CSV rows · Reference: 7685cb64 · Log: /tmp/ducs.log");
  });

  it("installs before the Wails callback constructs Error", () => {
    const callback=vi.fn();window.wails={Callback:callback};installWailsErrorNormalizer();
    window.wails.Callback?.(JSON.stringify({callbackid:"1",error:{code:"EXTENSION_UNAVAILABLE",message:"Extension download failed."}}));
    expect(JSON.parse(callback.mock.calls[0][0]).error).toBe("[EXTENSION_UNAVAILABLE] Extension download failed.");
  });
});
