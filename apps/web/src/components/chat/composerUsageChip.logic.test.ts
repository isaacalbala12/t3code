import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectUsageChipItems } from "./composerUsageChip.logic";

const window = (
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
  windowDurationMins?: number,
): ServerProviderUsageWindow => ({
  id: `${kind}-${usedPercent}`,
  kind,
  label: `${kind} label`,
  usedPercent,
  ...(windowDurationMins ? { windowDurationMins } : {}),
});

describe("selectUsageChipItems", () => {
  it("pairs the session window with the monthly one when a provider reports both", () => {
    const items = selectUsageChipItems([
      window("weekly", 1),
      window("monthly", 47.4),
      window("session", 0, 300),
    ]);
    expect(items.map((item) => [item.label, item.usedPercent])).toEqual([
      ["5h", 0],
      ["Mo", 47],
    ]);
  });

  it("falls back to weekly for providers without a monthly window", () => {
    expect(
      selectUsageChipItems([window("session", 80, 300), window("weekly", 95)]).map((item) => [
        item.label,
        item.severity,
      ]),
    ).toEqual([
      ["5h", "warning"],
      ["Wk", "critical"],
    ]);
  });

  it("handles a single window and none", () => {
    expect(selectUsageChipItems([window("weekly", 10)]).map((item) => item.label)).toEqual(["Wk"]);
    expect(selectUsageChipItems([])).toEqual([]);
  });
});
