import {
  DEEPSEEK_DEFAULT_MODEL,
  type DeepSeekSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  deepSeekModelSlugFromValue,
  deepSeekOptionConfigOptions,
  findDeepSeekModelConfigOption,
  flattenDeepSeekSelectChoices,
  makeDeepSeekAcpRuntime,
} from "../acp/DeepSeekAcpSupport.ts";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek Harness",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// Booting the profile loads every plugin before `session/new` answers.
const DEEPSEEK_ACP_DISCOVERY_TIMEOUT_MS = 30_000;
const DEEPSEEK_REPOSITORY_URL = "https://github.com/deepseek-ai/deepseek-harness";

/** Selectable without a live catalog: keep whatever model the dsh session is on. */
const DEEPSEEK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEEPSEEK_DEFAULT_MODEL,
    name: "Harness default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function deepSeekModelsFromSettings(
  customModels: DeepSeekSettings["customModels"] | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEEPSEEK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialDeepSeekProviderSnapshot(
  settings: DeepSeekSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: deepSeekModelsFromSettings(settings.customModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking DeepSeek Harness availability..."
          : "DeepSeek Harness is disabled in T3 Code settings.",
      },
    });
  });
}

/**
 * Turns dsh's session config options into T3 model options. dsh exposes model
 * picking as one option and every other tunable (reasoning effort, plugin
 * knobs) as further select or boolean options, so all of them surface here
 * without the adapter knowing their names.
 */
export function buildDeepSeekCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const optionDescriptors: Array<
    ReturnType<typeof buildSelectOptionDescriptor> | ReturnType<typeof buildBooleanOptionDescriptor>
  > = [];
  for (const option of deepSeekOptionConfigOptions(configOptions)) {
    const label = option.name.trim() || option.id;
    const description = option.description?.trim() || undefined;
    if (option.type === "boolean") {
      optionDescriptors.push(
        buildBooleanOptionDescriptor({
          id: option.id,
          label,
          currentValue: option.currentValue,
          ...(description ? { description } : {}),
        }),
      );
      continue;
    }
    const choices = flattenDeepSeekSelectChoices(option);
    if (choices.length === 0) {
      continue;
    }
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: option.id,
        label,
        ...(description ? { description } : {}),
        options: choices.map((choice) => ({
          value: choice.value,
          label: choice.name || choice.value,
          ...(choice.description ? { description: choice.description } : {}),
          ...(choice.value === option.currentValue ? { isDefault: true } : {}),
        })),
      }),
    );
  }
  return createModelCapabilities({ optionDescriptors });
}

export function buildDeepSeekModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const capabilities = buildDeepSeekCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  return flattenDeepSeekSelectChoices(findDeepSeekModelConfigOption(configOptions)).flatMap(
    (choice) => {
      const slug = deepSeekModelSlugFromValue(choice.value);
      if (!slug || seen.has(slug)) {
        return [];
      }
      seen.add(slug);
      const name = choice.name || slug;
      return [
        {
          slug,
          name: choice.group && !name.startsWith(choice.group) ? `${choice.group} · ${name}` : name,
          isCustom: false,
          capabilities,
        } satisfies ServerProviderModel,
      ];
    },
  );
}

/** Opens a throwaway `dsh` ACP session to read the profile's live model and option catalog. */
export const discoverDeepSeekModelsViaAcp = (
  settings: DeepSeekSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const runtime = yield* makeDeepSeekAcpRuntime({
      childProcessSpawner: spawner,
      deepSeekSettings: settings,
      ...(environment ? { environment } : {}),
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    }).pipe(Effect.provideService(Crypto.Crypto, crypto));
    yield* runtime.start();
    return buildDeepSeekModelsFromConfigOptions(yield* runtime.getConfigOptions);
  }).pipe(Effect.scoped);

// Each driver instance owns its cache; a version change invalidates it.
export const makeDeepSeekModelDiscovery = Effect.fn("makeDeepSeekModelDiscovery")(function* (
  settings: DeepSeekSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const cache = yield* Cache.makeWith(
    (_key: string) => discoverDeepSeekModelsViaAcp(settings, environment),
    {
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.length > 0 ? Duration.minutes(30) : Duration.zero,
    },
  );
  return {
    discover: (version: string | null) => Cache.get(cache, JSON.stringify([version])),
    invalidate: Cache.invalidateAll(cache),
  };
});

const runDeepSeekVersionCommand = (settings: DeepSeekSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(
      settings.binaryPath,
      ["--version"],
      environment ? { env: environment } : {},
    );
    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      ...(environment ? { env: environment } : { extendEnv: true }),
      shell: spawnCommand.shell,
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

function buildDeepSeekCommandMissingMessage(binaryPath: string): string {
  return [
    `DeepSeek Harness command \`${binaryPath}\` was not found.`,
    `Install it with \`npm install -g @deepseek-ai/dsh\` and make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
    `See ${DEEPSEEK_REPOSITORY_URL}.`,
  ].join(" ");
}

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  settings: DeepSeekSettings,
  environment?: NodeJS.ProcessEnv,
  discoverModels?: (version: string | null) => ReturnType<typeof discoverDeepSeekModelsViaAcp>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = deepSeekModelsFromSettings(settings.customModels);

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "DeepSeek Harness is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runDeepSeekVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    const missing = isCommandMissingCause(error);
    yield* Effect.logWarning("DeepSeek Harness health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? buildDeepSeekCommandMissingMessage(settings.binaryPath)
          : "Failed to execute the DeepSeek Harness health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "DeepSeek Harness is installed but timed out while running `dsh --version`.",
      },
    });
  }

  const version = parseGenericCliVersion(
    `${versionProbe.success.value.stdout}\n${versionProbe.success.value.stderr}`,
  );
  let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
  let warning: string | undefined;
  const discoveryExit = yield* Effect.exit(
    (discoverModels
      ? discoverModels(version)
      : discoverDeepSeekModelsViaAcp(settings, environment)
    ).pipe(Effect.timeoutOption(DEEPSEEK_ACP_DISCOVERY_TIMEOUT_MS)),
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("DeepSeek Harness ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    warning =
      "DeepSeek Harness ACP model discovery failed. Check that the configured profile boots (`dsh acp`) and see server logs for details.";
  } else if (Option.isNone(discoveryExit.value)) {
    warning = `DeepSeek Harness ACP model discovery timed out after ${DEEPSEEK_ACP_DISCOVERY_TIMEOUT_MS}ms.`;
  } else if (discoveryExit.value.value.length === 0) {
    warning =
      "DeepSeek Harness reported no models. Add a DeepSeek API key with `dsh web` (Settings → Models) or in $DSH_HOME.";
  } else {
    discoveredModels = discoveryExit.value.value;
  }

  return buildServerProvider({
    presentation: DEEPSEEK_PRESENTATION,
    enabled: true,
    checkedAt,
    models: providerModelsFromSettings(
      [...DEEPSEEK_BUILT_IN_MODELS, ...discoveredModels],
      settings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version,
      status: warning ? "warning" : "ready",
      // dsh keeps provider keys in its own home; T3 has no account to verify.
      auth: { status: "unknown" },
      ...(warning ? { message: warning } : {}),
    },
  });
});

/** Republishes version advisory metadata; model data comes only from provider checks. */
export const enrichDeepSeekSnapshot = (input: {
  readonly settings: DeepSeekSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  if (!settings.enabled) {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("DeepSeek Harness version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};
