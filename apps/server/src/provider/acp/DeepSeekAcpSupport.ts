import {
  DEEPSEEK_DEFAULT_MODEL,
  type DeepSeekSettings,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { expandHomePath } from "../../pathExpansion.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DSH_HOME_ENV = "DSH_HOME";
const DEFAULT_PROFILE = "acp";
// dsh's ACP server takes no credentials of its own: provider keys live in `$DSH_HOME`.
const DEEPSEEK_AUTH_METHOD_ID = "none";

type DeepSeekAcpRuntimeSettings = Pick<
  DeepSeekSettings,
  "binaryPath" | "profile" | "homePath" | "launchArgs"
>;

export interface DeepSeekAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn" | "resumeMethod"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly deepSeekSettings: DeepSeekAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/** `dsh <profile> [launch args]`. The shipped `acp` profile serves ACP over stdio. */
export function deepSeekAcpSpawnArgs(
  settings: Pick<DeepSeekSettings, "profile" | "launchArgs"> | null | undefined,
): ReadonlyArray<string> {
  return [settings?.profile?.trim() || DEFAULT_PROFILE, ...tokenizeCliArgs(settings?.launchArgs)];
}

export function deepSeekProcessEnvironment(
  settings: Pick<DeepSeekSettings, "homePath"> | null | undefined,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  const homePath = settings?.homePath?.trim();
  if (!homePath) {
    return environment;
  }
  return { ...(environment ?? process.env), [DSH_HOME_ENV]: expandHomePath(homePath) };
}

export function buildDeepSeekAcpSpawnInput(
  settings: DeepSeekAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const env = deepSeekProcessEnvironment(settings, environment);
  return {
    command: settings?.binaryPath || "dsh",
    args: [...deepSeekAcpSpawnArgs(settings)],
    cwd,
    ...(env ? { env } : {}),
  };
}

export const makeDeepSeekAcpRuntime = (
  input: DeepSeekAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDeepSeekAcpSpawnInput(input.deepSeekSettings, input.cwd, input.environment),
        authMethodId: DEEPSEEK_AUTH_METHOD_ID,
        // dsh advertises `session/resume` but not `session/load`.
        resumeMethod: "resume",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

// ── Config options ─────────────────────────────────────────────────────

/**
 * dsh identifies a model as a JSON `[providerId, modelId]` pair. T3 slugs are
 * plain `providerId/modelId` strings, so the pair never leaks into settings,
 * URLs, or stored selections.
 */
export function deepSeekModelSlugFromValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === "string" &&
        typeof parsed[1] === "string"
      ) {
        return `${parsed[0]}/${parsed[1]}`;
      }
    } catch {
      // Not the pair encoding; fall through and use the raw value.
    }
  }
  return trimmed;
}

export interface DeepSeekSelectChoice {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
  readonly group?: string;
}

export function flattenDeepSeekSelectChoices(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<DeepSeekSelectChoice> {
  if (!option || option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value,
            name: entry.name.trim(),
            ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
          },
        ]
      : entry.options.map((choice) => ({
          value: choice.value,
          name: choice.name.trim(),
          ...(choice.description?.trim() ? { description: choice.description.trim() } : {}),
          group: entry.name.trim(),
        })),
  );
}

export function findDeepSeekModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.type === "select" && option.category === "model");
}

/** Every configurable dimension other than the model picker, exposed as a T3 model option. */
export function deepSeekOptionConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return (configOptions ?? []).filter(
    (option) =>
      option.category !== "model" &&
      option.category !== "mode" &&
      option.id.trim() !== "mode" &&
      (option.type === "select" || option.type === "boolean"),
  );
}

export function resolveDeepSeekModelConfigValue(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  model: string | null | undefined,
): { readonly configId: string; readonly value: string } | undefined {
  const requested = model?.trim();
  if (!requested || requested === DEEPSEEK_DEFAULT_MODEL) {
    return undefined;
  }
  const modelOption = findDeepSeekModelConfigOption(configOptions);
  if (!modelOption) {
    return undefined;
  }
  const match = flattenDeepSeekSelectChoices(modelOption).find(
    (choice) =>
      choice.value === requested ||
      deepSeekModelSlugFromValue(choice.value) === requested ||
      choice.name === requested,
  );
  return match ? { configId: modelOption.id, value: match.value } : undefined;
}

export function resolveDeepSeekConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!selections || selections.length === 0) {
    return [];
  }
  const updates: Array<{ configId: string; value: string | boolean }> = [];
  for (const option of deepSeekOptionConfigOptions(configOptions)) {
    const selection = selections.find((entry) => entry.id === option.id);
    if (!selection) {
      continue;
    }
    if (option.type === "boolean") {
      if (typeof selection.value === "boolean") {
        updates.push({ configId: option.id, value: selection.value });
      }
      continue;
    }
    if (typeof selection.value !== "string") {
      continue;
    }
    const requested = selection.value;
    const choice = flattenDeepSeekSelectChoices(option).find(
      (candidate) => candidate.value === requested,
    );
    if (choice) {
      updates.push({ configId: option.id, value: choice.value });
    }
  }
  return updates;
}

export interface DeepSeekModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly configId: string;
}

/**
 * Applies the requested model and every option selection to the live session.
 * A model the running profile does not offer keeps the session's current model
 * rather than failing the turn.
 */
export function applyDeepSeekAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: DeepSeekModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const modelUpdate = resolveDeepSeekModelConfigValue(
      yield* input.runtime.getConfigOptions,
      input.model,
    );
    if (modelUpdate) {
      yield* input.runtime
        .setConfigOption(modelUpdate.configId, modelUpdate.value)
        .pipe(
          Effect.mapError((cause) => input.mapError({ cause, configId: modelUpdate.configId })),
        );
    }
    // Options are re-read after the model switch: they can differ per model.
    const updates = resolveDeepSeekConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.selections,
    );
    for (const update of updates) {
      yield* input.runtime
        .setConfigOption(update.configId, update.value)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, configId: update.configId })));
    }
  });
}
