// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import {
  parseDeepSeekAssistantMessage,
  readDeepSeekUsage,
  splitZstdFrames,
} from "./deepSeekUsageReader.ts";

const assistant = (seq: number, time: number, usage: object, model = "deepseek-v4-flash") =>
  JSON.stringify({
    type: "assistant/message",
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { id: `m${seq}`, role: "assistant", source: { provider: "opencode-go", model } },
      usage,
    },
  });

// dsh appends one zstd frame per write, and may interleave skippable frames.
const frame = (text: string) => NodeZlib.zstdCompressSync(Buffer.from(text));
const skippable = Buffer.concat([
  Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x03, 0x00, 0x00, 0x00]),
  Buffer.from([1, 2, 3]),
]);

const NOW = 1_790_000_000_000;

describe("deepSeekUsageReader", () => {
  it("splits concatenated and skippable zstd frames", () => {
    const parts = [frame("a\n"), skippable, frame("b\n"), frame("c\n")];
    const frames = splitZstdFrames(Buffer.concat(parts));
    expect(frames?.length).toBe(3);
    expect(frames?.map((f) => NodeZlib.zstdDecompressSync(f).toString()).join("")).toBe(
      "a\nb\nc\n",
    );
    expect(splitZstdFrames(Buffer.from("not zstd at all"))).toBeNull();
  });

  it("maps dsh usage to token totals", () => {
    const record = parseDeepSeekAssistantMessage(
      assistant(4, NOW, {
        inputTokens: 330,
        outputTokens: 180,
        totalTokens: 8943,
        cacheReadTokens: 8433,
      }),
      "s1",
    );
    expect(record).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sessionId: "s1",
      timestampMs: NOW,
      totals: {
        uncachedInputTokens: 330,
        cachedInputTokens: 8433,
        cacheCreationTokens: 0,
        outputTokens: 180,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
    });
    expect(parseDeepSeekAssistantMessage('{"type":"user/message"}', "s1")).toBeNull();
    expect(parseDeepSeekAssistantMessage(assistant(5, NOW, {}), "s1")).toBeNull();
  });

  it("reads sessions across frames, honors the window and reports gaps", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dsh-sessions-"));
    const write = (workspace: string, session: string, file: string, buffer: Buffer) => {
      const dir = NodePath.join(root, workspace, session);
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, file), buffer);
    };
    // One line split across two frames, plus an old record outside the window.
    const line = assistant(1, NOW, { inputTokens: 10, outputTokens: 5 });
    const old = assistant(2, NOW - 10_000_000, { inputTokens: 99, outputTokens: 99 });
    write(
      "ws",
      "session-a",
      "session.v4.jsonl.zstd",
      Buffer.concat([frame(`${old}\n${line.slice(0, 40)}`), frame(`${line.slice(40)}\n`)]),
    );
    write(
      "ws",
      "session-b",
      "session.v3.jsonl.zstd",
      frame(`${assistant(1, NOW, { inputTokens: 1 }, "deepseek-v4-pro")}\n`),
    );
    write("ws", "session-bad", "session.v4.jsonl.zstd", Buffer.from("garbage"));

    const result = await readDeepSeekUsage(root, NOW - 1_000);
    const records = result.files.flatMap((file) => file.records);
    expect(records.map((r) => [r.model, r.totals.uncachedInputTokens]).toSorted()).toEqual([
      ["deepseek-v4-flash", 10],
      ["deepseek-v4-pro", 1],
    ]);
    expect(result.error).toBe(true);
    expect(result.missing).toBe(false);
    expect((await readDeepSeekUsage(NodePath.join(root, "nope"), 0)).missing).toBe(true);
  });
});
