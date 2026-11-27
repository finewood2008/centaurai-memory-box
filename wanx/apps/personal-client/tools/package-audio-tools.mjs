import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(readFileSync(new URL("./audio-tools-win-x64.json", import.meta.url), "utf8"));
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
export function audioToolsDirectory(clientRoot = root) {
  return path.join(clientRoot, "build", "audio-tools", lock.sha256);
}
export function audioToolsResources(clientRoot = root, arch = "x64") {
  if (arch !== "x64") throw new Error("AUDIO_TOOLS_WINDOWS_X64_REQUIRED");
  return [{ from: audioToolsDirectory(clientRoot), to: "audio-tools" }];
}
function run(binary, args) {
  return execFileSync(binary, args, { windowsHide: true, encoding: "utf8", timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
}
// Authenticode changes the checksum and certificate-table directory and appends
// a WIN_CERTIFICATE record. Compare every other byte with the pinned input.
export function peSigningPayload(binary) {
  if (binary.length < 64 || binary.toString("ascii", 0, 2) !== "MZ") throw new Error("AUDIO_TOOLS_PE_INVALID");
  const pe = binary.readUInt32LE(60);
  const optional = pe + 24;
  const security = optional + 112 + 32;
  if (security + 8 > binary.length || binary.toString("ascii", pe, pe + 4) !== "PE\0\0" ||
      binary.readUInt16LE(optional) !== 0x20b) throw new Error("AUDIO_TOOLS_PE_INVALID");
  const offset = binary.readUInt32LE(security);
  const size = binary.readUInt32LE(security + 4);
  if (offset || size) {
    if (!offset || size < 8 || offset % 8 || offset + size !== binary.length ||
        offset < security + 8 || binary.readUInt32LE(offset) > size || binary.readUInt32LE(offset) < 8 ||
        binary.readUInt16LE(offset + 4) !== 0x200 || binary.readUInt16LE(offset + 6) !== 2)
      throw new Error("AUDIO_TOOLS_CERTIFICATE_TABLE_INVALID");
  }
  const content = binary.subarray(0, offset || binary.length);
  const payload = Buffer.alloc(Math.ceil(content.length / 8) * 8);
  content.copy(payload);
  payload.fill(0, optional + 64, optional + 68);
  payload.fill(0, security, security + 8);
  return payload;
}

function verifyAudioSignature(file, certificateSha1) {
  const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:WANX_AUDIO_SIGNED_FILE; " +
    "if($s.Status -ne 'Valid' -or !$s.SignerCertificate){throw 'AUDIO_TOOLS_SIGNATURE_INVALID'}; " +
    "if($env:WANX_AUDIO_CERTIFICATE -and $s.SignerCertificate.Thumbprint -ne $env:WANX_AUDIO_CERTIFICATE){throw 'AUDIO_TOOLS_SIGNER_MISMATCH'}";
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 60000, stdio: "pipe",
    env: { ...process.env, WANX_AUDIO_SIGNED_FILE: file, WANX_AUDIO_CERTIFICATE: certificateSha1 || "",
      PSModulePath: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") },
  });
}

export function verifyAudioTools(directory, { sourceDirectory, certificateSha1 } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.artifactSha256 !== lock.sha256 || !manifest.files?.length) throw new Error("AUDIO_TOOLS_MANIFEST_INVALID");
  if (sourceDirectory) {
    const original = verifyAudioTools(sourceDirectory);
    if (JSON.stringify(original) !== JSON.stringify(manifest)) throw new Error("AUDIO_TOOLS_MANIFEST_CHANGED");
  }
  for (const entry of manifest.files) {
    if (path.basename(entry.name) !== entry.name) throw new Error("AUDIO_TOOLS_FILENAME_INVALID");
    const file = path.join(directory, entry.name);
    if (hash(file) === entry.sha256) continue;
    if (!sourceDirectory || !/\.(exe|dll)$/i.test(entry.name))
      throw new Error("AUDIO_TOOLS_HASH_MISMATCH:" + entry.name);
    const source = readFileSync(path.join(sourceDirectory, entry.name));
    if (!peSigningPayload(source).equals(peSigningPayload(readFileSync(file))))
      throw new Error("AUDIO_TOOLS_PAYLOAD_MISMATCH:" + entry.name);
    verifyAudioSignature(file, certificateSha1);
  }
  for (const entry of manifest.files.filter(file => /\.(exe|dll)$/i.test(file.name))) {
    const binary = readFileSync(path.join(directory, entry.name));
    const pe = binary.length >= 64 ? binary.readUInt32LE(60) : binary.length;
    if (binary.toString("ascii", 0, 2) !== "MZ" || pe + 6 > binary.length ||
        binary.toString("ascii", pe, pe + 4) !== "PE\0\0" || binary.readUInt16LE(pe + 4) !== 0x8664)
      throw new Error("AUDIO_TOOLS_ARCH_MISMATCH:" + entry.name);
  }
  for (const name of ["LICENSE.txt", "COPYING.GPLv3", "SOURCE.json", "BUILD.txt", "NOTICE.txt"]) {
    if (!manifest.files.some(entry => entry.name === name)) throw new Error("AUDIO_TOOLS_NOTICE_MISSING:" + name);
  }
  for (const name of ["ffmpeg.exe", "ffprobe.exe"]) {
    if (!manifest.files.some(entry => entry.name === name)) throw new Error("AUDIO_TOOLS_MISSING:" + name);
    if (!run(path.join(directory, name), ["-version"]).includes(lock.version)) throw new Error("AUDIO_TOOLS_VERSION_MISMATCH");
  }
  if (!/\blibopus\b/.test(run(path.join(directory, "ffmpeg.exe"), ["-hide_banner", "-encoders"])))
    throw new Error("AUDIO_TOOLS_OPUS_MISSING");
  return manifest;
}
export async function prepareAudioTools({ clientRoot = root, arch = "x64" } = {}) {
  if (process.platform !== "win32" || arch !== "x64") throw new Error("AUDIO_TOOLS_WINDOWS_X64_REQUIRED");
  console.log("Preparing Windows audio tools: " + lock.version);
  const destination = audioToolsDirectory(clientRoot);
  if (existsSync(destination)) { verifyAudioTools(destination); return destination; }
  const cache = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "wanx-packager", "audio-tools");
  mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, lock.sha256 + ".zip");
  if (!existsSync(archive)) {
    const download = path.join(mkdtempSync(path.join(cache, "download-")), "ffmpeg.zip");
    run("curl.exe", ["--fail", "--location", "--retry", "2", "--max-time", "240", "--output", download, lock.url]);
    if (hash(download) !== lock.sha256) throw new Error("AUDIO_TOOLS_DOWNLOAD_HASH_MISMATCH");
    try { renameSync(download, archive); }
    catch (error) { if (!existsSync(archive)) throw error; }
  }
  if (hash(archive) !== lock.sha256) throw new Error("AUDIO_TOOLS_CACHE_HASH_MISMATCH");
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true });
  const temp = mkdtempSync(path.join(parent, "prepare-"));
  const extracted = path.join(temp, "extracted");
  mkdirSync(extracted);
  run("tar.exe", ["-xf", archive, "-C", extracted]);
  const folders = readdirSync(extracted);
  if (folders.length !== 1) throw new Error("AUDIO_TOOLS_ARCHIVE_LAYOUT_INVALID");
  const source = path.join(extracted, folders[0]);
  const output = path.join(temp, "output");
  mkdirSync(output);
  for (const name of readdirSync(path.join(source, "bin"))) {
    if (/\.dll$/i.test(name) || ["ffmpeg.exe", "ffprobe.exe"].includes(name)) cpSync(path.join(source, "bin", name), path.join(output, name));
  }
  cpSync(path.join(source, "LICENSE.txt"), path.join(output, "LICENSE.txt"));
  cpSync(new URL("./audio-tools-GPLv3.txt", import.meta.url), path.join(output, "COPYING.GPLv3"));
  writeFileSync(path.join(output, "BUILD.txt"), run(path.join(output, "ffmpeg.exe"), ["-version"]));
  writeFileSync(path.join(output, "NOTICE.txt"), "FFmpeg and FFprobe are distributed under LGPL-3.0-or-later.\nSee LICENSE.txt, SOURCE.json and BUILD.txt for license, corresponding source and configuration.\n");
  writeFileSync(path.join(output, "SOURCE.json"), JSON.stringify(lock, null, 2));
  const files = readdirSync(output).sort().map(name => ({ name, sha256: hash(path.join(output, name)) }));
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1, artifactSha256: lock.sha256, files }, null, 2));
  verifyAudioTools(output);
  try { renameSync(output, destination); }
  catch (error) { if (!existsSync(destination)) throw error; verifyAudioTools(destination); }
  if (path.dirname(temp) !== parent) throw new Error("AUDIO_TOOLS_TEMP_PATH_INVALID");
  rmSync(temp, { recursive: true, force: true });
  console.log("Windows audio tools verified: " + lock.version);
  return destination;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareAudioTools();
