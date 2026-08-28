import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadDebugFile } from "@/lib/eeg/debug-export";

describe("debug file downloads", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the native file share sheet on iPhone", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone)");
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await downloadDebugFile("capture.json", "{\"ok\":true}", "application/json");

    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "capture.json",
        files: [expect.objectContaining({ name: "capture.json" })],
      }),
    );
    expect(click).not.toHaveBeenCalled();
  });

  it("retains the normal file download on desktop", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome");
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:debug");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await downloadDebugFile("capture.json", "{}", "application/json");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });
});