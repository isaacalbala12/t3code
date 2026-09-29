// @effect-diagnostics nodeBuiltinImport:off - resolving the dsh home is a Node filesystem boundary.
import * as NodeOS from "node:os";

import type { DeepSeekSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Yaml from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";
import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";
import { fetchOpenCodeGoUsageLimits } from "./openCodeUsageLimits.ts";

const OPENCODE_GO_PROVIDER = "opencode-go";
const DEFAULT_API_KEY_ENV = "OPENCODE_GO_API_KEY";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The env var a profile's `opencode-go` provider reads its key from (`apiKeyEnv`). */
export function findOpenCodeGoApiKeyEnv(patchSources: ReadonlyArray<string>): string {
  for (const source of patchSources) {
    let parsed: unknown;
    try {
      parsed = Yaml.parse(source);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      const provider = record(record(record(record(entry).config).providers)[OPENCODE_GO_PROVIDER]);
      if (typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv.trim()) {
        return provider.apiKeyEnv.trim();
      }
    }
  }
  return DEFAULT_API_KEY_ENV;
}

/** dsh's credential store keeps write-only key references under `refs`. */
export function readCredentialRef(source: string, name: string): string | undefined {
  try {
    const value = record(record(Yaml.parse(source)).refs)[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * dsh reaches OpenCode Go through its `opencode-go` model provider, so the subscription
 * allowance is read with the same key dsh uses: the environment first, then dsh's own
 * credential store. Without an `opencode-go` key there is nothing to report.
 */
export const readDeepSeekUsageLimits = Effect.fn("readDeepSeekUsageLimits")(function* (input: {
  readonly settings: Pick<
    DeepSeekSettings,
    "enabled" | "homePath" | "profile" | "sharedConfigProfile"
  >;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.settings.enabled) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const configuredHome = input.settings.homePath.trim() || env.DSH_HOME?.trim();
    const home = configuredHome
      ? expandHomePath(configuredHome)
      : path.join(NodeOS.homedir(), ".dsh");
    const readOptional = (file: string) =>
      fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));

    const profiles = [
      input.settings.profile.trim() || "acp",
      input.settings.sharedConfigProfile.trim(),
    ].filter(Boolean);
    const patches = yield* Effect.forEach(profiles, (profile) =>
      readOptional(path.join(home, "profiles", profile, "cordis.patch.yml")),
    );
    const keyEnv = findOpenCodeGoApiKeyEnv(patches);
    const apiKey =
      env[keyEnv]?.trim() ||
      readCredentialRef(yield* readOptional(path.join(home, ".credentials.yaml")), keyEnv);
    if (!apiKey) return unsupported;
    return yield* fetchOpenCodeGoUsageLimits(apiKey, checkedAt);
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read usage.",
      }),
    ),
  );
});
