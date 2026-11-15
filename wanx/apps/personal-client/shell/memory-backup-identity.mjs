import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const probeOptions = { timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024 };

async function machineId(platform) {
  if (platform === "darwin") {
    const { stdout } = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], probeOptions);
    return /"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i.exec(stdout)?.[1];
  }
  if (platform === "win32") {
    const system = process.env.SystemRoot || "C:\\Windows";
    const powershell = path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid; (Get-CimInstance Win32_ComputerSystemProduct).UUID",
    ], probeOptions);
    return stdout.trim().split(/\s+/).join("/");
  }
  if (platform === "linux") return (await readFile("/etc/machine-id", "utf8")).trim();
}

export async function readBackupSourceBinding(userData, platform = process.platform) {
  const [machine, profile] = await Promise.all([machineId(platform), realpath(userData)]).catch(() => []);
  const ids = machine?.replaceAll("-", "").toLowerCase().split("/") ?? [];
  if (!profile || ids.length !== (platform === "win32" ? 2 : 1) ||
      ids.some(id => !/^[a-f0-9]{32}$/.test(id) || /^(?:0{32}|f{32})$/.test(id))) {
    throw Object.assign(new Error("无法识别本机备份来源，请检查设备标识。"), { code: "MEMORY_BACKUP_SOURCE_UNAVAILABLE" });
  }
  // Do not send the OS identity or local profile path to the box.
  return { platform, binding: createHash("sha256").update(JSON.stringify([platform, ids, profile])).digest("hex") };
}

export function backupSourceId(binding, seed) {
  return createHash("sha256").update(JSON.stringify(["memobox-backup-v2", binding, seed])).digest("hex").slice(0, 32);
}
