// Node zlib decodes zstd and Node fs walks dsh's session directories.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeZlib from "node:zlib";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const SESSION_FILE = /^session\.v[34]\.jsonl\.zstd$/;
const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;
// A session larger than this is skipped rather than held in memory.
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * dsh appends one zstd frame per write, and Node's decoder stops at the first frame,
 * so the file is split into frames by walking their headers and blocks. Returns the
 * frames in order, or `null` when the bytes are not well-formed zstd.
 */
export function splitZstdFrames(buffer: Buffer): Buffer[] | null {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) return null;
    const magic = buffer.readUInt32LE(offset);
    if ((magic & ZSTD_SKIPPABLE_MASK) >>> 0 === ZSTD_SKIPPABLE_MAGIC) {
      if (offset + 8 > buffer.length) return null;
      offset += 8 + buffer.readUInt32LE(offset + 4);
      if (offset > buffer.length) return null;
      continue;
    }
    if (magic !== ZSTD_MAGIC) return null;
    const start = offset;
    offset += 4;
    if (offset >= buffer.length) return null;
    const descriptor = buffer[offset++]!;
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    if (!singleSegment) offset += 1;
    offset += dictionaryFlag === 3 ? 4 : dictionaryFlag;
    offset += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    for (;;) {
      if (offset + 3 > buffer.length) return null;
      const header = buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
      offset += 3;
      const type = (header >> 1) & 3;
      if (type === 3) return null;
      offset += type === 1 ? 1 : header >> 3;
      if ((header & 1) !== 0) break;
    }
    if (hasChecksum) offset += 4;
    if (offset > buffer.length) return null;
    frames.push(buffer.subarray(start, offset));
  }
  return frames;
}

/**
 * dsh reports uncached input, output and cache reads separately
 * (`total = input + output + cacheRead`). Reasoning tokens are not broken out.
 */
export function parseDeepSeekAssistantMessage(line: string, sessionId: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const event = object(parsed);
  if (event.type !== "assistant/message") return null;
  const data = object(event.data);
  const usage = object(data.usage);
  const message = object(data.message);
  const source = object(message.source);
  const model = text(source.model);
  const timestampMs = event.time;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const totals = {
    uncachedInputTokens: tokens(usage.inputTokens),
    cachedInputTokens: tokens(usage.cacheReadTokens),
    cacheCreationTokens: tokens(usage.cacheWriteTokens),
    outputTokens: tokens(usage.outputTokens),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;
  const id = text(message.id) || text(event.seq);
  return {
    provider: "deepseek",
    timestampMs,
    model,
    sessionId,
    totals,
    // dsh records no price; the shared rate table (or a custom price) estimates cost.
    reportedCostUsd: null,
    fast: false,
    dedupeKey: id ? `deepseek:${sessionId}:${id}` : null,
  };
}

async function parseSessionFile(
  path: string,
  sessionId: string,
  sinceMs: number,
): Promise<UsageRecord[] | null> {
  const frames = splitZstdFrames(await NodeFSP.readFile(path));
  if (frames === null) return null;
  const records: UsageRecord[] = [];
  let carry = "";
  let count = 0;
  const consume = (line: string) => {
    if (!line.includes('"assistant/message"')) return;
    const record = parseDeepSeekAssistantMessage(line, sessionId);
    if (record !== null && record.timestampMs >= sinceMs) records.push(record);
  };
  for (const frame of frames) {
    const chunk = carry + NodeZlib.zstdDecompressSync(frame).toString("utf8");
    const lines = chunk.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (++count % 64 === 0) await NodeTimersPromises.setImmediate();
  }
  consume(carry);
  return records;
}

export interface DeepSeekUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

/** Reads `<root>/<workspace>/<session>/session.v{3,4}.jsonl.zstd` without modifying them. */
export async function readDeepSeekUsage(
  root: string,
  sinceMs: number,
): Promise<DeepSeekUsageReadResult> {
  const files: { path: string; records: UsageRecord[] }[] = [];
  let found = false;
  let error = false;
  const recordError = (cause: unknown) => {
    if (object(cause).code !== "ENOENT") error = true;
  };

  let workspaces: string[] = [];
  try {
    workspaces = (await NodeFSP.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => NodePath.join(root, entry.name));
  } catch (cause) {
    recordError(cause);
  }
  for (const workspace of workspaces) {
    let sessions: string[] = [];
    try {
      sessions = (await NodeFSP.readdir(workspace, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (cause) {
      recordError(cause);
      continue;
    }
    for (const session of sessions) {
      const sessionDir = NodePath.join(workspace, session);
      let names: string[] = [];
      try {
        names = (await NodeFSP.readdir(sessionDir)).filter((name) => SESSION_FILE.test(name));
      } catch (cause) {
        recordError(cause);
        continue;
      }
      // v4 supersedes v3 when a session was migrated in place.
      const name = names.toSorted().at(-1);
      if (name === undefined) continue;
      found = true;
      const path = NodePath.join(sessionDir, name);
      try {
        const stat = await NodeFSP.stat(path);
        // A session untouched since before the window cannot hold records inside it.
        if (stat.mtimeMs < sinceMs) continue;
        if (stat.size > MAX_SESSION_BYTES) {
          error = true;
          continue;
        }
        const records = await parseSessionFile(path, session, sinceMs);
        if (records === null) {
          error = true;
          continue;
        }
        files.push({ path, records });
      } catch (cause) {
        recordError(cause);
      }
    }
  }
  return { files, missing: !found && !error, error };
}
