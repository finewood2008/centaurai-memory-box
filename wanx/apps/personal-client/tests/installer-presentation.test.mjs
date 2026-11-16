import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const client = fileURLToPath(new URL('../', import.meta.url));
const ui = await readFile(path.join(client, 'shell/installer-ui.nsh'), 'utf8');
const installer = await readFile(path.join(client, 'shell/installer.nsh'), 'utf8');
const functionBody = (source, name) => {
  const body = source.match(new RegExp(`Function ${name}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1];
  assert.ok(body, name); return body;
};
const macroBody = (name) => {
  const body = installer.match(new RegExp(`!macro ${name}\\r?\\n([\\s\\S]*?)!macroend`))?.[1];
  assert.ok(body, name); return body;
};

test('the welcome page embeds one static brand mark without a carousel or video runtime', () => {
  assert.match(ui, /resources\\installer\\redesign\\windows-mark\.bmp/);
  assert.equal((ui.match(/^\s*File \/oname=/gm) || []).length, 1);
  assert.doesNotMatch(ui, /SysAnimate32|\.avi|CreateTimer|SlideTimer|PauseButton|上一页|下一页|暂停/);
  assert.match(ui, /MUI_INSTFILESPAGE_COLORS "715A45 FCF9F5"/);
  assert.match(functionBody(ui, 'WanxWelcomeCleanup'), /NSD_FreeImage/);
  assert.match(functionBody(ui, 'WanxWelcomePage'), /SetErrorLevel 1603\s+Quit/);
});

test('only an explicitly chosen directory is normalized, preserving existing upgrade and command-line paths', () => {
  const page = functionBody(ui, 'WanxWelcomePage');
  assert.match(page, /\$\{If\} \$\{isUpdated\}\s+Abort/);
  assert.match(page, /EM_SETREADONLY/);
  assert.match(page, /StrCpy \$wxDirectoryChanged 0/);
  assert.doesNotMatch(page, /StrCpy \$INSTDIR|Call WanxNormalizeInstallFolder/);
  const choose = functionBody(ui, 'WanxChooseInstallFolder');
  assert.match(choose, /SelectFolderDialog/);
  assert.match(choose, /\$0 == error[\s\S]*?Return[\s\S]*?StrCpy \$INSTDIR/);
  assert.match(choose, /StrCpy \$wxDirectoryChanged 1/);
  assert.match(functionBody(ui, 'WanxWelcomeLeave'), /\$\{If\} \$wxDirectoryChanged == 1\s+Call WanxNormalizeInstallFolder\s+\$\{EndIf\}/);
  assert.match(functionBody(ui, 'WanxWelcomeLeave'), /StrLen \$0 "\$INSTDIR"[\s\S]*?WANX_MAX_INSTALL_DIR_LENGTH[\s\S]*?Abort[\s\S]*?Call WanxWelcomeCleanup/, 'an overlong interactive path stays on the welcome page before its bitmap is freed');
  assert.match(functionBody(ui, 'WanxNormalizeInstallFolder'), /\$\{GetFileName\}[\s\S]*?\$0 != "\$\{APP_FILENAME\}"[\s\S]*?\$INSTDIR\\\$\{APP_FILENAME\}/);
});

test('installation keeps the native progress and optional details, without drawing synthetic progress', () => {
  assert.match(ui, /ShowInstDetails hide/);
  assert.match(macroBody('customPageAfterChangeDir'), /Page custom WanxPreflightPage/);
  assert.match(macroBody('customPageAfterChangeDir'), /MUI_PAGE_CUSTOMFUNCTION_SHOW WanxInstallShow/);
  assert.doesNotMatch(ui, /CreateProgressBar|PBM_SETPOS|PBM_SETRANGE|NSD_CreateTimer|SetTimer/);
  assert.match(ui, /MUI_FINISHPAGE_RUN_TEXT "打开记忆盒子"/);
});

test('presentation preserves silent, current-user, path-length and ACL guards before successful completion', () => {
  assert.match(installer, /!define WANX_MAX_INSTALL_DIR_LENGTH 85/);
  const init = macroBody('customInit');
  assert.match(init, /\$installMode == "all"[\s\S]*?SetErrorLevel 1603[\s\S]*?Quit/);
  assert.match(init, /IfSilent wxSilentGuard wxSilentGuardDone[\s\S]*?Call WanxAssertInstallPathLength[\s\S]*?-Mode Preflight/);
  assert.match(macroBody('customInstallMode'), /StrCpy \$isForceCurrentInstall "1"/);
  const before = functionBody(installer, 'WanxPreflightPage');
  assert.match(before, /Call WanxAssertInstallPathLength[\s\S]*?-Mode Preflight[\s\S]*?SetErrorLevel 1603[\s\S]*?Quit[\s\S]*?Abort/);
  const finish = macroBody('customInstall');
  assert.match(finish, /-Mode ProtectTree[\s\S]*?IfSilent \+2[\s\S]*?SetErrorLevel 1603[\s\S]*?Abort[\s\S]*?-Mode VerifyTree[\s\S]*?IfSilent \+2[\s\S]*?SetErrorLevel 1603[\s\S]*?Abort/);
});

const compiler = process.env.MEMOBOX_TEST_MAKENSIS;
test('the actual NSIS compiler accepts the native pages and unchanged security hooks', { skip: !compiler }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'memobox-installer-presentation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const quote = value => '"' + value.replaceAll('$', '$$').replaceAll('"', '$\\"') + '"';
  const source = path.join(root, 'presentation.nsi'), output = path.join(root, 'presentation.exe');
  await mkdir(path.join(root, 'scratch'));
  const lines = [
    'Unicode true', 'RequestExecutionLevel user', 'Name "Memory Box presentation compile fixture"',
    'OutFile ' + quote(output), 'InstallDir "$LOCALAPPDATA\\Programs\\半人马AI记忆盒子"',
    '!include MUI2.nsh', '!include LogicLib.nsh',
    '!define PROJECT_DIR ' + quote(client), '!define VERSION "1.0.6-windows-preview.2"',
    '!define APP_FILENAME "半人马AI记忆盒子"', '!define isUpdated "0 = 1"',
    'Var installMode', 'Var isForceCurrentInstall',
    '!include ' + quote(path.join(client, 'shell/installer.nsh')),
    '!insertmacro customWelcomePage', '!insertmacro customPageAfterChangeDir',
    '!insertmacro MUI_PAGE_INSTFILES', '!define MUI_FINISHPAGE_RUN "$WINDIR\\notepad.exe"',
    '!insertmacro MUI_PAGE_FINISH', '!insertmacro MUI_LANGUAGE "SimpChinese"',
    '!insertmacro customHeader', 'Function .onInit', 'StrCpy $installMode "current"',
    '!insertmacro customInstallMode', '!insertmacro customInit', 'FunctionEnd',
    'Section', 'DetailPrint "Synthetic compile fixture; do not install"',
    '!insertmacro customInstall', 'SectionEnd',
  ];
  await writeFile(source, lines.join('\n') + '\n');
  const result = spawnSync(compiler, ['-V3', source], { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal((await readFile(output)).subarray(0, 2).toString('ascii'), 'MZ');
});
