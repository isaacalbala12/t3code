import type { ServerProviderUsageWindow } from "@t3tools/contracts";

export interface UsageChipItem {
  readonly window: ServerProviderUsageWindow;
  readonly label: string;
  readonly usedPercent: number;
  readonly severity: "normal" | "warning" | "critical";
}

const LONG_WINDOW_ORDER: ReadonlyArray<ServerProviderUsageWindow["kind"]> = [
  "monthly",
  "weekly",
  "other",
];

function shortLabel(window: ServerProviderUsageWindow): string {
  switch (window.kind) {
    case "session":
      return window.windowDurationMins
        ? `${Math.round((window.windowDurationMins / 60) * 10) / 10}h`
        : "Session";
    case "weekly":
      return "Wk";
    case "monthly":
      return "Mo";
    default:
      return window.label;
  }
}

function severityOf(usedPercent: number): UsageChipItem["severity"] {
  return usedPercent >= 90 ? "critical" : usedPercent >= 75 ? "warning" : "normal";
}

/**
 * The two windows worth a permanent glance: the short session window (5 h) and the longest
 * allowance behind it (monthly, else weekly). Claude and Codex report session + weekly;
 * OpenCode Go reports session + weekly + monthly.
 */
export function selectUsageChipItems(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<UsageChipItem> {
  const session = windows.find((window) => window.kind === "session");
  const long = LONG_WINDOW_ORDER.map((kind) => windows.find((window) => window.kind === kind)).find(
    (window) => window !== undefined,
  );
  return [session, long].flatMap((window) =>
    window
      ? [
          {
            window,
            label: shortLabel(window),
            usedPercent: Math.round(window.usedPercent),
            severity: severityOf(window.usedPercent),
          },
        ]
      : [],
  );
}
