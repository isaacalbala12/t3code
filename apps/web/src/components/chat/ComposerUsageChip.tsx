import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { formatResetsIn, remainingPercent } from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { selectUsageChipItems } from "./composerUsageChip.logic";

/**
 * Always-visible read of the selected provider's session and long-window usage, so the allowance
 * is visible without opening Usage. Renders nothing for providers that report no windows.
 */
export function ComposerUsageChip({
  limits,
}: {
  readonly limits: ServerProviderUsageLimits | undefined;
}) {
  const items = selectUsageChipItems(limits?.windows ?? []);
  if (items.length === 0) return null;
  // Countdowns are relative to the last probe, which refreshes on the provider health interval.
  const now = Date.parse(limits?.checkedAt ?? "");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={items
              .map((item) => `${item.window.label}: ${item.usedPercent}% used`)
              .join(", ")}
            className="hidden shrink-0 cursor-default items-center gap-2 px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:inline-flex"
          />
        }
      >
        <GaugeIcon className="size-3.5" aria-hidden />
        {items.map((item) => (
          <span
            key={item.window.id}
            className={cn(
              item.severity === "warning" && "text-warning-foreground",
              item.severity === "critical" && "text-error-foreground",
            )}
          >
            {item.label} {item.usedPercent}%
          </span>
        ))}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-1">
          {items.map((item) => {
            const resetsIn = formatResetsIn(item.window, now);
            return (
              <span key={item.window.id} className="text-foreground">
                {item.window.label}: {item.usedPercent}% used · {remainingPercent(item.window)}%
                left
                {resetsIn ? <span className="text-muted-foreground"> · {resetsIn}</span> : null}
              </span>
            );
          })}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
