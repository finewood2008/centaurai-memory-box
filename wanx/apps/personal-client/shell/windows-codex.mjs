import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const family = "OpenAI.Codex_2p2nqsd0c76g0";

function powerShell() {
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root)) throw new Error("WINDOWS_CODEX_UNAVAILABLE");
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function argumentsFor(script) {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export async function detectWindowsCodex() {
  try {
    const { stdout } = await run(powerShell(), argumentsFor(`
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      $package = Get-AppxPackage -Name OpenAI.Codex | Where-Object PackageFamilyName -eq '${family}' | Select-Object -First 1
      if (!$package) { exit 1 }
      $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
      if (!$manifest.SelectSingleNode("//*[local-name()='Protocol' and @Name='codex']")) { exit 1 }
      [Console]::Write($package.Version.ToString())
    `), { windowsHide: true, timeout: 5000, encoding: "utf8" });
    const version = stdout.trim();
    return /^\d+(?:\.\d+){3}$/.test(version) ? { version } : null;
  } catch {
    return null;
  }
}

const launchScript = `
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.System.Launcher,Windows.System,ContentType=WindowsRuntime]
  $null = [Windows.System.LauncherOptions,Windows.System,ContentType=WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Length -eq 1
  } | Select-Object -First 1
  $link = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  $uri = [Uri]::new($link, [UriKind]::Absolute)
  $options = [Windows.System.LauncherOptions]::new()
  $options.TargetApplicationPackageFamilyName = '${family}'
  $operation = [Windows.System.Launcher]::LaunchUriAsync($uri, $options)
  $task = $asTask.MakeGenericMethod([bool]).Invoke($null, @($operation))
  if (!$task.GetAwaiter().GetResult()) { exit 2 }
`;

export async function openWindowsCodex(url) {
  const uri = new URL(url);
  if (uri.protocol !== "codex:" || uri.host !== "threads" || uri.pathname !== "/new" ||
      uri.username || uri.password || uri.hash) throw new Error("WINDOWS_CODEX_URL_INVALID");
  await new Promise((resolve, reject) => {
    // Pass the draft through stdin to keep it off the command line.
    const child = spawn(powerShell(), argumentsFor(launchScript), {
      windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
    });
    const unavailable = () => reject(new Error("WINDOWS_CODEX_UNAVAILABLE"));
    const timer = setTimeout(() => {
      child.kill();
      unavailable();
    }, 15_000);
    child.stdin.on("error", unavailable);
    child.once("error", () => { clearTimeout(timer); unavailable(); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else unavailable();
    });
    child.stdin.end(Buffer.from(uri.href, "utf8").toString("base64"));
  });
}
