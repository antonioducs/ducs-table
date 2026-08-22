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

  it("installs before the Wails callback constructs Error", () => {
    const callback=vi.fn();window.wails={Callback:callback};installWailsErrorNormalizer();
    window.wails.Callback?.(JSON.stringify({callbackid:"1",error:{code:"EXTENSION_UNAVAILABLE",message:"Extension download failed."}}));
    expect(JSON.parse(callback.mock.calls[0][0]).error).toBe("[EXTENSION_UNAVAILABLE] Extension download failed.");
  });
});
