/**
 * Optional integration check against a real `dsh acp` install.
 * Enable with: T3_DEEPSEEK_ACP_PROBE=1 vp test run DeepSeekAcpCliProbe
 * Set T3_DEEPSEEK_LIVE_TURN=1 to also send a small prompt to the real model.
 *
 * dsh keeps provider keys in `$DSH_HOME`; the live turn needs a DeepSeek key there.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  checkDeepSeekProviderStatus,
  discoverDeepSeekModelsViaAcp,
} from "../Layers/DeepSeekProvider.ts";
import { applyDeepSeekAcpModelSelection, makeDeepSeekAcpRuntime } from "./DeepSeekAcpSupport.ts";

const settings = {
  enabled: true,
  binaryPath: process.env.T3_DEEPSEEK_BINARY ?? "dsh",
  profile: "",
  homePath: "",
  launchArgs: "",
  customModels: [],
} as const;

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  return yield* makeDeepSeekAcpRuntime({
    deepSeekSettings: settings,
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-deepseek-probe", version: "0.0.0" },
  }).pipe(Effect.provideService(Crypto.Crypto, crypto));
});

describe.runIf(process.env.T3_DEEPSEEK_ACP_PROBE === "1")("DeepSeek ACP CLI probe", () => {
  it.effect("discovers models and per-model options from session/new", () =>
    Effect.gen(function* () {
      const models = yield* discoverDeepSeekModelsViaAcp(settings, process.env);
      expect(models.length).toBeGreaterThan(0);
      const optionIds = models[0]?.capabilities?.optionDescriptors?.map((d) => d.id) ?? [];
      expect(optionIds).toContain("reasoning_effort");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a ready provider snapshot with the live catalog", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const snapshot = yield* checkDeepSeekProviderStatus(settings, process.env).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(
        snapshot.models.some((model) => model.slug === "deepseek-official/deepseek-v4-pro"),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("applies a model and reasoning effort through session/set_config_option", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      yield* applyDeepSeekAcpModelSelection({
        runtime,
        model: "deepseek-official/deepseek-v4-flash",
        selections: [{ id: "reasoning_effort", value: "off" }],
        mapError: ({ cause }) => cause,
      });
      const options = yield* runtime.getConfigOptions;
      expect(options.find((option) => option.id === "reasoning_effort")?.currentValue).toBe("off");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.runIf(process.env.T3_DEEPSEEK_LIVE_TURN === "1")(
    "completes a live prompt turn",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime;
        const output = yield* Ref.make("");
        yield* runtime.handleSessionUpdate(({ update }) => {
          if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
          const { content } = update;
          return content.type === "text"
            ? Ref.update(output, (current) => current + content.text)
            : Effect.void;
        });
        yield* runtime.start();
        yield* applyDeepSeekAcpModelSelection({
          runtime,
          model: "deepseek-official/deepseek-v4-flash",
          selections: [{ id: "reasoning_effort", value: "off" }],
          mapError: ({ cause }) => cause,
        });
        const result = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Reply with exactly the word: pong" }],
        });
        expect(result.stopReason).toBe("end_turn");
        expect((yield* Ref.get(output)).toLowerCase()).toContain("pong");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );
});
