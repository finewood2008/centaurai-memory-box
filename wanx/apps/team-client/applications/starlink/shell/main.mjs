import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  dialog,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fromEnvironment } from "@centaurai/wanx-host-sdk";
import { attachElectronHost } from "@centaurai/wanx-host-sdk/electron";
import { SemanticaService } from "./service.mjs";
import { createStarlinkTarget } from "./starlink-target.mjs";
import { workbenchErrorReply } from './workbench-errors.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = pathToFileURL(path.join(root, "ui/index.html")).href;
if (process.env.WANX_HOST_USER_DATA_DIR) attachElectronHost();
const host = fromEnvironment();
app.setName("万象·星图");
nativeTheme.themeSource = "light";
if (!host)
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "wanx-semantica-standalone"),
  );
let window, service, targetNavigation;
app
  .whenReady()
  .then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "星图",
          submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
        },
        {
          label: "编辑",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "窗口",
          submenu: [{ role: "minimize" }, { role: "togglefullscreen" }],
        },
      ]),
    );
    window = new BrowserWindow({
      width: 1480,
      height: 960,
      minWidth: 760,
      minHeight: 620,
      title: "万象·星图  WanX·Starlink",
      icon: path.join(root, "resources/icon.png"),
      backgroundColor: "#faf7f2",
      webPreferences: {
        preload: path.join(root, "shell/preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    if (process.platform === "darwin")
      app.dock.setIcon(path.join(root, "resources/icon.png"));
    app.setAboutPanelOptions({
      applicationName: "星图 STARLINK",
      applicationVersion: app.getVersion(),
      copyright: "半人马AI",
    });
    window.webContents.on("will-frame-navigate", (event) => {
      const target = event.url?.split("?")[0];
      const workbench = pathToFileURL(path.join(root, "ui/workbench/index.html")).href;
      if (target && target !== page && target !== workbench) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== page) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    service = new SemanticaService({
      host,
      emit: (value) => {
        if (!window.isDestroyed())
          window.webContents.send("semantica:event", value);
      },
      selectFiles: async ({multiple = true} = {}) => {
        const result = await dialog.showOpenDialog(window, {
          title: "导入知识材料",
          properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
          filters: [
            {
              name: "知识材料",
              extensions: [
                "txt",
                "md",
                "markdown",
                "pdf",
                "docx",
                "png",
                "jpg",
                "jpeg",
                "webp",
                "wav",
                "mp3",
                "m4a",
                "flac",
                "pptx",
                "xlsx",
                "xls",
                "xlsm",
              ],
            },
          ],
        });
        return result.canceled ? [] : result.filePaths;
      },
      selectSave: async (filename) => {
        const result = await dialog.showSaveDialog(window, {
          title: filename.endsWith(".zip") ? "下载 Skill ZIP" : "保存材料原件",
          defaultPath: filename,
        });
        return result.canceled ? null : result.filePath;
      },
      selectSkill: async () => {
        const result = await dialog.showOpenDialog(window, {title:"导入 Skill ZIP",properties:["openFile"],filters:[{name:"Skill ZIP",extensions:["zip"]}]});
        return result.canceled ? [] : result.filePaths;
      },
    });
    targetNavigation = createStarlinkTarget({
      host, service, launchId: process.env.WANX_HOST_LAUNCH_ID,
      send: message => process.send?.(message, () => {}),
      emit: value => { if (!window.isDestroyed()) window.webContents.send("semantica:event", value); },
    });
    process.on("message", message => void targetNavigation.receive(message));
    ipcMain.handle(
      "semantica:action",
      async (event, { action, input } = {}) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== page
        )
          return { ok: false, code: "UNTRUSTED_FRAME" };
        try {
          if (["launch-target", "launch-target-applied"].includes(action)) {
            const value = await targetNavigation.call(action, input);
            if (action === "launch-target-applied" && input.ok === true) { window.show(); window.focus(); }
            return { ok: true, value };
          }
          if (action === "open-model-management") {
            service.assertLive();
            const requestId = randomUUID();
            const opened = await new Promise(resolve => {
              const finish = value => { clearTimeout(timer); process.removeListener("message", receive); resolve(value); };
              const receive = message => { if(message?.type === "wanx:open-models-result" && message.requestId === requestId && message.launchId === process.env.WANX_HOST_LAUNCH_ID) finish(message.ok === true); };
              const timer = setTimeout(()=>finish(false), 4000);
              process.on("message",receive);
              process.send?.({type:"wanx:open-models",requestId,launchId:process.env.WANX_HOST_LAUNCH_ID},()=>{});
            });
            return {ok:true,value:{opened}};
          }
          return { ok: true, value: await service.call(action, input) };
        } catch (error) {
          if (action?.startsWith('onboarding-') || action?.startsWith('conversation-') || ['workbench-request','create-warehouse','reprocess-models'].includes(action)) return workbenchErrorReply(error);
          return {
            ok: false,
            code: /^[A-Z][A-Z_]+$/.test(error.code || "")
              ? error.code
              : "SEMANTICA_REQUEST_FAILED",
            message: error.publicMessage,
          };
        }
      },
    );
    await window.loadURL(page);
  })
  .catch(() => app.quit());
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => service?.close());
