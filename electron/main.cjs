const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { validate } = require("./store.cjs");
let win;
let queue = Promise.resolve();
app.whenReady().then(() => {
  const file = path.join(app.getPath("userData"), "workspace.json");
  ipcMain.handle("workspace:read", async (event) => {
    if (event.sender !== win.webContents) throw new Error("Invalid sender");
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  ipcMain.handle("workspace:save", (event, data) => {
    if (event.sender !== win.webContents) throw new Error("Invalid sender");
    validate(data);
    const save = queue.then(async () => {
      await fs.writeFile(file + ".tmp", JSON.stringify(data), "utf8");
      await fs.rename(file + ".tmp", file);
    });
    queue = save.catch(() => {});
    return save;
  });
  const create = () => {
    win = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1024,
      minHeight: 720,
      backgroundColor: "#f7f8fa",
      title: "WorkOrder",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.loadFile(path.join(__dirname, "../index.html"));
  };
  create();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) create();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
