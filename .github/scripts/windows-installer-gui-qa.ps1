param(
    [Parameter(Mandatory)][string] $Installer,
    [Parameter(Mandatory)][string] $OutputPath,
    [string] $ExpectedPayload
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class InstallerWindow {
    public delegate bool Callback(IntPtr hwnd, IntPtr data);
    [StructLayout(LayoutKind.Sequential)]
    public struct Rectangle { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, Callback callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int processId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rectangle rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] public static extern IntPtr SetControlText(IntPtr hwnd, uint msg, IntPtr wp, string value);
    public static IntPtr[] Windows() {
        var windows = new List<IntPtr>();
        EnumWindows((hwnd, data) => { if (IsWindowVisible(hwnd)) windows.Add(hwnd); return true; }, IntPtr.Zero);
        return windows.ToArray();
    }
    public static IntPtr[] Children(IntPtr parent) {
        var children = new List<IntPtr>();
        EnumChildWindows(parent, (hwnd, data) => { if (IsWindowVisible(hwnd)) children.Add(hwnd); return true; }, IntPtr.Zero);
        return children.ToArray();
    }
    public static string Class(IntPtr hwnd) {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }
    public static string Text(IntPtr hwnd) {
        var text = new StringBuilder(512);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }
    public static int Pid(IntPtr hwnd) {
        int id;
        GetWindowThreadProcessId(hwnd, out id);
        return id;
    }
}
'@
[void][InstallerWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))

function Save-InstallerDialog([IntPtr] $Window, [string] $Name) {
    $rect = New-Object InstallerWindow+Rectangle
    if (-not [InstallerWindow]::GetWindowRect($Window, [ref]$rect)) { throw 'Cannot measure installer window' }
    $bitmap = [Drawing.Bitmap]::new(($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $dc = $graphics.GetHdc()
        try {
            if (-not [InstallerWindow]::PrintWindow($Window, $dc, 2)) { throw 'Cannot capture installer window' }
        } finally { $graphics.ReleaseHdc($dc) }
        $bitmap.Save((Join-Path $OutputPath "$Name.png"), [Drawing.Imaging.ImageFormat]::Png)
        [InstallerWindow]::Children($Window) | ForEach-Object {
            $bounds = New-Object InstallerWindow+Rectangle
            [void][InstallerWindow]::GetWindowRect($_, [ref]$bounds)
            $value = [InstallerWindow]::Text($_)
            $label = [InstallerWindow]::Class($_)
            "$label $($bounds.Left - $rect.Left),$($bounds.Top - $rect.Top) $($bounds.Right - $bounds.Left)x$($bounds.Bottom - $bounds.Top) $value"
        } | Set-Content -Path (Join-Path $OutputPath "$Name.txt") -Encoding utf8
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Find-ChildClass([IntPtr] $Window, [string] $ClassName) {
    foreach ($child in [InstallerWindow]::Children($Window)) {
        if ([InstallerWindow]::Class($child) -eq $ClassName) { return $child }
    }
    return [IntPtr]::Zero
}

function Find-Window([int] $ProcessId, [string] $TextPattern) {
    foreach ($window in [InstallerWindow]::Windows()) {
        if ([InstallerWindow]::Class($window) -ne '#32770') { continue }
        if ([InstallerWindow]::Pid($window) -eq $ProcessId -or [InstallerWindow]::Text($window) -match $TextPattern) {
            return $window
        }
    }
    return [IntPtr]::Zero
}

$process = Start-Process -FilePath $Installer -ArgumentList '/LANG=2052' -PassThru
$pattern = '\u8bb0\u5fc6\u76d2\u5b50|MemoBox'
$finished = '\u5b89\u88c5\u5b8c\u6210|Finish'
"UserInteractive=$([Environment]::UserInteractive), Session=$($process.SessionId), Explorer=$(@(Get-Process explorer -ErrorAction SilentlyContinue).Count)" |
    Set-Content (Join-Path $OutputPath 'session.txt')
$window = [IntPtr]::Zero
$location = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $location -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 400
    $window = Find-Window $process.Id $pattern
    if ($window -ne [IntPtr]::Zero) { $location = Find-ChildClass $window 'Edit' }
}
if ($window -ne [IntPtr]::Zero) { Save-InstallerDialog $window '01-welcome' }
if ($window -ne [IntPtr]::Zero) {
    "DPI=$([InstallerWindow]::GetDpiForWindow($window))" | Add-Content (Join-Path $OutputPath 'session.txt')
}
if ($location -eq [IntPtr]::Zero) { throw 'The graphical installer did not show the installation location field' }
$next = [InstallerWindow]::GetDlgItem($window, 1)
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\MemoBox-GuiQA'
[void][InstallerWindow]::SetControlText($location, 0xC, [IntPtr]::Zero, $installRoot)
[void][InstallerWindow]::PostMessage($next, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
$capturedProgress = $false
$animationFrames = [Collections.Generic.HashSet[string]]::new()
$capturedFinish = $false
for ($i = 0; $i -lt 350; $i++) {
    Start-Sleep -Milliseconds 250
    $window = Find-Window $process.Id $pattern
    if ($window -eq [IntPtr]::Zero) { continue }
    if (-not $capturedProgress -and (Find-ChildClass $window 'msctls_progress32') -ne [IntPtr]::Zero) {
        Save-InstallerDialog $window '02-installing'
        $capturedProgress = $true
    }
    $animation = Find-ChildClass $window 'SysAnimate32'
    if ($animation -ne [IntPtr]::Zero -and $animationFrames.Count -lt 3 -and $i % 4 -eq 0) {
        $frame = New-Object InstallerWindow+Rectangle
        [void][InstallerWindow]::GetWindowRect($animation, [ref]$frame)
        $bitmap = [Drawing.Bitmap]::new(($frame.Right - $frame.Left), ($frame.Bottom - $frame.Top))
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($frame.Left, $frame.Top, 0, 0, $bitmap.Size)
            $framePath = Join-Path $OutputPath 'frame-current.png'
            $bitmap.Save($framePath, [Drawing.Imaging.ImageFormat]::Png)
            if ($animationFrames.Add((Get-FileHash $framePath).Hash)) {
                Move-Item $framePath (Join-Path $OutputPath "02-slide-$($animationFrames.Count).png")
            } else {
                Remove-Item $framePath
            }
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
    $next = [InstallerWindow]::GetDlgItem($window, 1)
    if ([InstallerWindow]::IsWindowEnabled($next) -and [InstallerWindow]::Text($next) -match $finished) {
        Save-InstallerDialog $window '03-finish'
        foreach ($child in [InstallerWindow]::Children($window)) {
            if ([InstallerWindow]::Class($child) -eq 'Button' -and [InstallerWindow]::Text($child) -match $pattern) {
                [void][InstallerWindow]::SendMessage($child, 0xF1, [IntPtr]::Zero, [IntPtr]::Zero)
            }
        }
        [void][InstallerWindow]::SendMessage($next, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
        $capturedFinish = $true
        break
    }
}
if (-not $capturedFinish) {
    if ($window -ne [IntPtr]::Zero) { Save-InstallerDialog $window 'last-installer-dialog' }
    throw 'The graphical installer did not reach its completion screen'
}
if (-not $process.WaitForExit(15000) -or $process.ExitCode -ne 0) { throw 'Installer did not exit successfully' }
$installed = @(Get-ChildItem $installRoot -Filter '*.exe' -Recurse | Where-Object { $_.Name -notlike '*uninstall*' })
if (-not $installed.Count) { throw 'No application files found in the selected location' }
if (-not $capturedProgress) { throw 'No installation progress window was captured' }
if ($ExpectedPayload) {
    $appAsar = @(Get-ChildItem $installRoot -Filter 'app.asar' -Recurse)
    if ($appAsar.Count -ne 1 -or (Get-FileHash $appAsar[0].FullName).Hash -ne (Get-FileHash $ExpectedPayload).Hash) {
        throw 'The graphical installer produced a different app payload'
    }
    $applicationDir = Split-Path $appAsar[0].DirectoryName
    if (-not (Get-Acl -LiteralPath $applicationDir).AreAccessRulesProtected) { throw 'The graphical installation ACL is not protected' }
    if ($animationFrames.Count -lt 2) { throw "The graphical installation did not show a changing feature illustration" }
}
