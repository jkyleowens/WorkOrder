// Renders the PWA / app-store icon set from web/public/mark.svg.
//
// The repository ships one 260-byte SVG and no raster art, but installable web
// apps and both native stores need PNGs. Rather than commit opaque binaries
// with no source, this regenerates them from the mark with Chromium, which is
// already present for the Playwright suites.
//
// Two shapes are produced. The standard icon fills its square, the way a home
// screen shows it on iOS. The maskable icon keeps the mark inside the middle
// ~60% so Android can crop it to a circle or squircle without clipping the
// wireframe — a maskable icon drawn edge to edge loses its corners.
import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "web", "public", "icons");
const mark = await readFile(join(root, "web", "public", "mark.svg"), "utf8");
// --paper from industry.css. iOS refuses transparency in an app icon, so the
// ground is painted rather than left clear.
const GROUND = "#fafafb";
const sizes = [
  { file: "icon-192.png", size: 192, inset: 18 },
  { file: "icon-512.png", size: 512, inset: 18 },
  { file: "apple-touch-icon.png", size: 180, inset: 16 },
  { file: "icon-maskable-512.png", size: 512, inset: 30 },
];
// Honours PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, the same override the Playwright
// configs use, so a machine with a system Chromium does not need a second copy.
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  }),
});
try {
  for (const { file, size, inset } of sizes) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>
         html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:${GROUND};}
         .wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:${inset}%;}
         svg{width:100%;height:100%;display:block;}
       </style><div class="wrap">${mark}</div>`,
    );
    await writeFile(join(dir, file), await page.screenshot({ type: "png" }));
    await page.close();
    console.log(`${file}  ${size}x${size}`);
  }
} finally {
  await browser.close();
}
