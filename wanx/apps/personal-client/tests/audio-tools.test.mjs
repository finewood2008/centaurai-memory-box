import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { packagedAudioEnvironment } from "../shell/audio-tools.mjs";
import { audioToolsResources, peSigningPayload } from "../tools/package-audio-tools.mjs";
import { probeAudio } from "../resources/accessory-preview/lib/audio-input.mjs";

test("packaged audio commands use the installation path with Unicode and spaces", () => {
  const root = path.resolve("录音 安装目录");
  const env = packagedAudioEnvironment(root);
  assert.equal(env.FFMPEG_BIN, path.join(root, "audio-tools", "ffmpeg.exe"));
  assert.equal(env.FFPROBE_BIN, path.join(root, "audio-tools", "ffprobe.exe"));
  assert.equal(audioToolsResources(root)[0].to, "audio-tools");
  assert.throws(() => audioToolsResources(root, "arm64"), /X64_REQUIRED/);
});

test("missing audio command reports the local component failure", async () => {
  const previous = process.env.FFPROBE_BIN;
  try {
    process.env.FFPROBE_BIN = path.resolve("missing-audio-tools", "ffprobe.exe");
    await assert.rejects(probeAudio("unused.wav"), {
      code: "AUDIO_TOOL_UNAVAILABLE", audioToolUnavailable: true,
    });
  } finally {
    if (previous === undefined) delete process.env.FFPROBE_BIN;
    else process.env.FFPROBE_BIN = previous;
  }
});

test("PE signing comparison preserves payload changes and rejects malformed certificate tables", () => {
  const original = Buffer.alloc(512);
  original.write("MZ");
  original.writeUInt32LE(64, 60);
  original.write("PE\0\0", 64);
  const optional = 88;
  original.writeUInt16LE(0x20b, optional);
  const signed = Buffer.concat([original, Buffer.alloc(16)]);
  signed.writeUInt32LE(123, optional + 64);
  signed.writeUInt32LE(512, optional + 144);
  signed.writeUInt32LE(16, optional + 148);
  signed.writeUInt32LE(16, 512);
  signed.writeUInt16LE(0x200, 516);
  signed.writeUInt16LE(2, 518);
  assert.deepEqual(peSigningPayload(original), peSigningPayload(signed));
  const changed = Buffer.from(signed);
  changed[400] = 1;
  assert.notDeepEqual(peSigningPayload(original), peSigningPayload(changed));
  const invalid = Buffer.from(signed);
  invalid.writeUInt32LE(8, optional + 148);
  assert.throws(() => peSigningPayload(invalid), /CERTIFICATE_TABLE_INVALID/);
  assert.throws(() => peSigningPayload(Buffer.from("invalid")), /PE_INVALID/);
});
