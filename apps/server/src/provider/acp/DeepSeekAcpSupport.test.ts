import { DEEPSEEK_DEFAULT_MODEL, type DeepSeekSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildDeepSeekCapabilitiesFromConfigOptions,
  buildDeepSeekModelsFromConfigOptions,
} from "../Layers/DeepSeekProvider.ts";
import {
  buildDeepSeekAcpSpawnInput,
  deepSeekModelSlugFromValue,
  resolveDeepSeekConfigUpdates,
  resolveDeepSeekModelConfigValue,
} from "./DeepSeekAcpSupport.ts";

// Captured from `dsh acp` (0.1.7-rc.2) `session/new`.
const flash = '["deepseek-official","deepseek-v4-flash"]';
const pro = '["deepseek-official","deepseek-v4-pro"]';
const CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: flash,
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: flash, name: "deepseek-v4-flash" },
          { value: pro, name: "DeepSeek-V4-Pro", description: "Stronger agentic coding" },
        ],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
  { id: "web_search", name: "Web search", type: "boolean", currentValue: false },
] as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const settings = (overrides: Partial<DeepSeekSettings>): DeepSeekSettings =>
  ({
    enabled: true,
    binaryPath: "dsh",
    profile: "",
    homePath: "",
    launchArgs: "",
    customModels: [],
    ...overrides,
  }) as DeepSeekSettings;

describe("DeepSeekAcpSupport", () => {
  it("boots the acp profile by default and honors profile, launch args and DSH_HOME", () => {
    expect(buildDeepSeekAcpSpawnInput(settings({}), "/w", {})).toMatchObject({
      command: "dsh",
      args: ["acp"],
    });
    const custom = buildDeepSeekAcpSpawnInput(
      settings({
        binaryPath: "/opt/dsh",
        profile: "work",
        launchArgs: "--patch ./o.yml",
        homePath: "/data/dsh",
      }),
      "/w",
      { PATH: "/bin" },
    );
    expect(custom.command).toBe("/opt/dsh");
    expect(custom.args).toEqual(["work", "--patch", "./o.yml"]);
    expect(custom.env).toMatchObject({ PATH: "/bin", DSH_HOME: "/data/dsh" });
  });

  it("maps dsh's JSON model pair to a plain provider/model slug", () => {
    expect(deepSeekModelSlugFromValue(flash)).toBe("deepseek-official/deepseek-v4-flash");
    expect(deepSeekModelSlugFromValue("plain-model")).toBe("plain-model");
    expect(deepSeekModelSlugFromValue("[not json")).toBe("[not json");
  });

  it("resolves slugs back to the config value and keeps the session model for the default", () => {
    expect(
      resolveDeepSeekModelConfigValue(CONFIG_OPTIONS, "deepseek-official/deepseek-v4-pro"),
    ).toEqual({ configId: "model", value: pro });
    expect(resolveDeepSeekModelConfigValue(CONFIG_OPTIONS, DEEPSEEK_DEFAULT_MODEL)).toBeUndefined();
    expect(resolveDeepSeekModelConfigValue(CONFIG_OPTIONS, "unknown/model")).toBeUndefined();
  });

  it("exposes every non-model config option as a model option", () => {
    const capabilities = buildDeepSeekCapabilitiesFromConfigOptions(CONFIG_OPTIONS);
    expect(capabilities.optionDescriptors?.map((d) => [d.id, d.type])).toEqual([
      ["reasoning_effort", "select"],
      ["web_search", "boolean"],
    ]);
    const reasoning = capabilities.optionDescriptors?.[0];
    expect(reasoning?.type === "select" && reasoning.currentValue).toBe("high");
    expect(buildDeepSeekModelsFromConfigOptions(CONFIG_OPTIONS).map((m) => m.slug)).toEqual([
      "deepseek-official/deepseek-v4-flash",
      "deepseek-official/deepseek-v4-pro",
    ]);
  });

  it("turns option selections into config updates and drops unknown values", () => {
    expect(
      resolveDeepSeekConfigUpdates(CONFIG_OPTIONS, [
        { id: "reasoning_effort", value: "max" },
        { id: "web_search", value: true },
        { id: "reasoning_effort_typo", value: "max" },
      ]),
    ).toEqual([
      { configId: "reasoning_effort", value: "max" },
      { configId: "web_search", value: true },
    ]);
    expect(
      resolveDeepSeekConfigUpdates(CONFIG_OPTIONS, [{ id: "reasoning_effort", value: "ultra" }]),
    ).toEqual([]);
  });
});
