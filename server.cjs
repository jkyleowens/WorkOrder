const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
http
  .createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    if (
      !["/index.html", "/src/app.js", "/src/styles.css"].includes(
        pathname === "/" ? "/index.html" : pathname,
      )
    ) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.setHeader(
        "Content-Type",
        { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[
          path.extname(file)
        ],
      );
      res.end(data);
    });
  })
  .listen(5173, "127.0.0.1", () =>
    console.log("WorkOrder preview: http://localhost:5173"),
  );
