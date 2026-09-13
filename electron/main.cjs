const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");

const repoRoot = path.join(__dirname, "..");
const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || "3000";
const baseUrl = `http://${host}:${port}`;

let win;
let serverProcess;

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
      });
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for the WorkOrder server"));
        return;
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

function startServer() {
  serverProcess = spawn(
    process.execPath,
    ["--env-file=.env", "backend/start.cjs"],
    {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
    },
  );
  serverProcess.on("exit", (code) => {
    serverProcess = undefined;
    if (code && code !== 0 && win) {
      win.webContents.loadURL(
        "data:text/plain," +
          encodeURIComponent(
            "The WorkOrder server exited unexpectedly. Check the terminal for details and restart the app.",
          ),
      );
    }
  });
}

function createWindow() {
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
  win.loadURL(`${baseUrl}/register`);
}

app.whenReady().then(async () => {
  startServer();
  createWindow();
  try {
    await waitForServer(`${baseUrl}/api/health`);
    win.webContents.reload();
  } catch (error) {
    win.webContents.loadURL(
      "data:text/plain," +
        encodeURIComponent(
          "Could not reach the WorkOrder server: " + error.message,
        ),
    );
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = undefined;
  }
}

app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", stopServer);
process.on("exit", stopServer);
