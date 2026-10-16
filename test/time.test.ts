import { describe, expect, it } from "vitest";
import { isInsideWindow, localDay, localMinutes } from "../src/time.js";

describe("Taiwan time helpers", () => {
  it("converts UTC into Asia/Taipei without relying on worker locale", () => {
    const at = new Date("2026-10-15T22:15:00.000Z");
    expect(localMinutes(at, "Asia/Taipei")).toBe(6 * 60 + 15);
    expect(localDay(at, "Asia/Taipei")).toBe("2026-10-16");
  });

  it("uses a half-open quiet interval", () => {
    expect(
      isInsideWindow(
        new Date("2026-10-15T05:29:59.000Z"),
        "Asia/Taipei",
        "04:00",
        "13:30",
      ),
    ).toBe(true);
    expect(
      isInsideWindow(
        new Date("2026-10-15T05:30:00.000Z"),
        "Asia/Taipei",
        "04:00",
        "13:30",
      ),
    ).toBe(false);
  });
});
