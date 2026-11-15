import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

export function createStartupSettings({ app, platform = process.platform, preferenceFile, argv = process.argv, testBuild = false }) {
  // Installed branded source builds have a stable launchable bundle too.
  const installedBundle = platform === "darwin" && app.isInApplicationsFolder?.() === true &&
    ["半人马AI记忆盒子.app", "半人马AI-记忆盒子.app", "\u4e07\u8c61.app"].includes(path.basename(path.resolve(app.getPath("exe"), "../../..")));
  const windows = platform === "win32";
  const supported = !testBuild && ["darwin", "win32"].includes(platform) && (app.isPackaged || installedBundle);
  const loginArguments = ["--wanx-login-startup"];
  const loginName = "半人马AI记忆盒子";
  const legacyLoginName = "\u4e07\u8c61";
  const loginOptions = windows && supported ? { path: app.getPath("exe"), args: loginArguments } : {};
  // Electron 37 can omit double-dash arguments from launchItems. Match the
  // installed executable and our registry value instead of its parsed args.
  const readSettings = () => windows ? app.getLoginItemSettings({ path: loginOptions.path }) : app.getLoginItemSettings();
  const sameExecutable = item => item.scope === "user" && typeof item.path === "string" &&
    path.win32.normalize(item.path).toLowerCase() === path.win32.normalize(loginOptions.path).toLowerCase();
  const legacyItem = settings => settings.launchItems?.find(item => item.name === legacyLoginName && sameExecutable(item));
  const removeLegacy = () => app.setLoginItemSettings({ ...loginOptions, openAtLogin: false, enabled: false, name: legacyLoginName });
  const writeSettings = enabled => {
    if (windows && legacyItem(readSettings())) removeLegacy();
    app.setLoginItemSettings({ openAtLogin: enabled,
      ...(windows ? { ...loginOptions, enabled, name: loginName } : {}) });
  };
  const preferences = preferenceFile ?? (app.getPath ? path.join(app.getPath("userData"), "startup-preferences.json") : null);
  function remember(enabled) {
    if (!preferences) return;
    mkdirSync(path.dirname(preferences), { recursive: true });
    const temporary = `${preferences}.tmp`;
    writeFileSync(temporary, JSON.stringify({ initialized: true, enabled }) + "\n", { mode: 0o600 });
    renameSync(temporary, preferences);
  }
  const unavailable = () => ({
    supported: false,
    enabled: false,
    status: "unsupported",
    reason: testBuild ? "测试版本不注册登录启动。" : !["darwin", "win32"].includes(platform)
      ? "此版本暂不支持设置登录时启动。"
      : "请安装记忆盒子正式版后设置登录时启动。",
  });

  function get() {
    if (!supported) return unavailable();
    const settings = readSettings();
    const item = windows ? settings.launchItems.find(value => value.name === loginName && sameExecutable(value)) || legacyItem(settings) : null;
    const enabled = windows ? item?.enabled === true : settings.openAtLogin === true;
    const status = windows ? item ? enabled ? "enabled" : "disabled" : "not-registered"
      : settings.status || (enabled ? "enabled" : "not-registered");
    return {
      supported: true,
      enabled: enabled && status === "enabled",
      status,
      reason: status === "requires-approval"
        ? "请在系统设置中允许记忆盒子登录时启动。"
        : status === "disabled" ? "已在系统启动应用设置中关闭，可在此重新开启。"
        : status === "not-found" ? "系统未找到记忆盒子，请从安装位置重新打开应用。" : null,
    };
  }

  return Object.freeze({
    get,
    initializeDefault() {
      if (!supported) return unavailable();
      if (!preferences) throw new Error("缺少启动偏好存储位置。");
      if (windows) {
        const settings = readSettings(), legacy = legacyItem(settings);
        if (legacy) {
          const current = settings.launchItems.find(item => item.name === loginName && sameExecutable(item));
          if (current) removeLegacy();
          else { writeSettings(legacy.enabled === true); remember(legacy.enabled === true); }
          return get();
        }
      }
      try {
        const saved = JSON.parse(readFileSync(preferences, "utf8"));
        if (saved.initialized === true) return get();
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const current = get();
      if (!current.enabled && ["not-registered", "not-found"].includes(current.status)) {
        writeSettings(true);
        const updated = get();
        if (updated.enabled || updated.status === "requires-approval") remember(true);
        return updated;
      }
      remember(current.enabled);
      return current;
    },
    set(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("启动设置必须为布尔值。");
      if (!supported) return unavailable();
      writeSettings(enabled);
      const result = get();
      remember(enabled);
      return result;
    },
    wasOpenedAtLogin() {
      return supported && (windows ? argv.includes("--wanx-login-startup") : readSettings().wasOpenedAtLogin === true);
    },
  });
}
