// Photo capture for field work, on a phone and on a desktop browser.
//
// A crew member standing on a jobsite photographs progress for a daily report.
// Two paths reach the same place:
//
//   * Native (Capacitor): the @capacitor/camera plugin, reached through the
//     bridge it registers at window.Capacitor.Plugins.Camera. This app has no
//     bundler — web/public/*.js are served as raw ES modules — so the bare
//     "@capacitor/camera" specifier cannot be imported from here; the global
//     bridge is the plugin's supported no-bundler entry point, and its absence
//     is exactly what we feature-detect on.
//   * Web: the plain <input type="file"> that has always been there. Nothing
//     about the desktop path changes.
//
// Either way the bytes are decoded, resized and re-encoded as JPEG before they
// are handed back. A current phone camera writes 5-12 MB files and /api/files
// refuses anything over 4 MB, so an unresized capture fails exactly when it
// matters most — standing in the field with one bar of signal.
//
// Required native permission strings (the generated ios/ project is gitignored):
//   NSCameraUsageDescription      — "WorkOrder uses the camera so you can
//                                    photograph site progress for a daily report."
//   NSPhotoLibraryUsageDescription — "WorkOrder opens your photo library so you
//                                    can attach site photos you already took."
// Android needs android.permission.CAMERA and, on API 32 and below,
// READ_EXTERNAL_STORAGE.
import { esc, field } from "./ui.js";
import { isNative } from "./native.js";

// The server rejects anything larger; body-parser caps the raw body at the same
// number, so downscaling aims comfortably below it rather than at the edge.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const TARGET_BYTES = 3.5 * 1024 * 1024;
// A 2048px long edge reads a stud layout, a serial plate or a crack width back
// on a desktop screen, which is what a site record has to be good for.
const MAX_EDGE = 2048;
const THUMBNAIL_EDGE = 220;
// Tried in order until the encoded photo fits. The last step still leaves a
// 1280px long edge, which is a usable record rather than a thumbnail.
const STEPS = [
  [MAX_EDGE, 0.82],
  [MAX_EDGE, 0.7],
  [1600, 0.7],
  [1280, 0.62],
];
const SERVER_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ACCEPT = SERVER_TYPES.join(",");
const CAMERA_DENIED =
  "WorkOrder cannot open the camera because camera access is turned off. Open Settings, find WorkOrder, turn Camera on, then try again — or attach a photo from your library instead.";
const LIBRARY_DENIED =
  "WorkOrder cannot open your photo library because photo access is turned off. Open Settings, find WorkOrder, allow Photos, then try again — or take a new photo instead.";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

const onNative = async () => isNative();
const cameraPlugin = () => globalThis.Capacitor?.Plugins?.Camera || null;

// True only when a real native camera can be opened. Everything else — desktop
// browsers, mobile web, a native build without the plugin — keeps the file input.
export async function cameraAvailable() {
  return (await onNative()) && !!cameraPlugin();
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function ensurePermission(camera, source) {
  const key = source === "library" ? "photos" : "camera";
  if (typeof camera.checkPermissions !== "function") return;
  let state;
  try {
    state = (await camera.checkPermissions())?.[key];
  } catch {
    return; // An older bridge without permission reporting: let getPhoto answer.
  }
  if (state === "prompt" || state === "prompt-with-rationale")
    try {
      state = (await camera.requestPermissions({ permissions: [key] }))?.[key];
    } catch {
      return;
    }
  if (state === "denied")
    throw new Error(key === "photos" ? LIBRARY_DENIED : CAMERA_DENIED);
}

// Returns a File, or null when the crew member backed out of the camera.
export async function capture(source = "camera") {
  const camera = cameraPlugin();
  if (!camera)
    throw new Error(
      "This build cannot open the camera. Attach a photo from your files instead.",
    );
  await ensurePermission(camera, source);
  let photo;
  try {
    photo = await camera.getPhoto({
      quality: 90,
      allowEditing: false,
      correctOrientation: true,
      saveToGallery: false,
      // base64 keeps the bytes inside the web view. Reading the plugin's
      // file:// webPath instead would depend on the shell's connect-src policy,
      // which this module does not control.
      resultType: "base64",
      source: source === "library" ? "PHOTOS" : "CAMERA",
      width: MAX_EDGE,
      presentationStyle: "fullscreen",
    });
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/cancel/i.test(message)) return null;
    if (/denied|permission|not allowed|unauthorized/i.test(message))
      throw new Error(source === "library" ? LIBRARY_DENIED : CAMERA_DENIED);
    throw new Error(`The camera could not return a photo: ${message}`);
  }
  if (!photo?.base64String) return null;
  return decodeBase64(photo.base64String, photo.format);
}

function decodeBase64(base64, format) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const extension = format === "png" || format === "webp" ? format : "jpg";
  const type = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  return asFile(
    new Blob([bytes], { type }),
    `site-photo-${Date.now()}.${extension}`,
  );
}

// ---------------------------------------------------------------------------
// Downscale and re-encode
// ---------------------------------------------------------------------------

function asFile(blob, name) {
  try {
    return new File([blob], name, { type: blob.type });
  } catch {
    blob.name = name; // Very old WebKit: a named Blob uploads the same way.
    return blob;
  }
}

const jpegName = (name) =>
  `${
    String(name || "photo")
      .split(/[\\/]/)
      .pop()
      .replace(/\.[^.]*$/, "")
      .slice(0, 60) || "photo"
  }.jpg`;

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Older WebKit rejects the options bag but decodes fine without it.
      return await createImageBitmap(file);
    }
  }
  return decodeWithImageElement(file);
}

function decodeWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the photo."));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode the photo."));
      // A data: URL, not a blob: URL — the app's CSP allows img-src 'self' data:.
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function surface(width, height) {
  if (typeof OffscreenCanvas === "function")
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function encode(canvas, quality) {
  if (canvas.convertToBlob)
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not encode the photo.")),
      "image/jpeg",
      quality,
    ),
  );
}

function paint(source, width, height) {
  const canvas = surface(width, height);
  const context = canvas.getContext("2d");
  // JPEG carries no alpha: flatten a transparent PNG onto white rather than black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

const dataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not build a preview."));
    reader.readAsDataURL(blob);
  });

async function thumbnail(bitmap) {
  const scale = Math.min(
    1,
    THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height),
  );
  const canvas = paint(
    bitmap,
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  );
  return dataUrl(await encode(canvas, 0.7));
}

// Decodes a captured or chosen photo, resizes it to something a daily report
// can actually be read from, and re-encodes it as JPEG under the upload cap.
// Returns { file, preview, width, height } where width/height are the original
// pixel dimensions.
export async function preparePhoto(input, { preview = true } = {}) {
  if (!input?.size) throw new Error("That photo came back empty. Try again.");
  let bitmap;
  try {
    bitmap = await decode(input);
  } catch {
    // Resizing is an optimisation, not a gate. If this browser cannot decode
    // the image but the server would take it as-is, send the original bytes
    // rather than refuse a photo the crew already has. Only a file that is
    // both undecodable and too large is genuinely unusable.
    if (input.size <= MAX_UPLOAD_BYTES && SERVER_TYPES.includes(input.type))
      return { file: input, preview: "", width: 0, height: 0 };
    throw new Error(
      `Could not read ${input.name || "that photo"}. Attach a JPEG, PNG or WebP image under ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    );
  }
  try {
    const width = bitmap.width,
      height = bitmap.height;
    const longest = Math.max(width, height);
    let blob;
    for (const [edge, quality] of STEPS) {
      const scale = Math.min(1, edge / longest);
      blob = await encode(
        paint(
          bitmap,
          Math.max(1, Math.round(width * scale)),
          Math.max(1, Math.round(height * scale)),
        ),
        quality,
      );
      if (blob.size <= TARGET_BYTES) break;
    }
    if (blob.size > MAX_UPLOAD_BYTES)
      throw new Error(
        "This photo is too detailed to upload even after resizing. Take it again at a lower camera resolution.",
      );
    // A photo that was already small and already the right size is left alone:
    // re-encoding it as JPEG would lose quality and save nothing.
    const keepOriginal =
      longest <= MAX_EDGE &&
      input.size <= TARGET_BYTES &&
      blob.size >= input.size &&
      SERVER_TYPES.includes(input.type);
    return {
      file: keepOriginal
        ? input
        : asFile(blob, jpegName(input.name || "site-photo")),
      preview: preview ? await thumbnail(bitmap).catch(() => "") : "",
      width,
      height,
    };
  } finally {
    bitmap.close?.();
  }
}

// For attachments that are not necessarily photos (a scope document may be a
// PDF): shrink an oversized image, pass anything else through untouched.
export async function shrinkIfNeeded(file) {
  if (
    !file?.size ||
    !String(file.type || "").startsWith("image/") ||
    file.size <= MAX_UPLOAD_BYTES
  )
    return file;
  return (await preparePhoto(file, { preview: false })).file;
}

// ---------------------------------------------------------------------------
// The capture field, for use inside modal()
// ---------------------------------------------------------------------------

// Rendered markup only; call mountPhotos() on the container afterwards.
export function photoField({
  name = "photos",
  legend = "Progress photos",
  label = "Photos",
  max = 12,
} = {}) {
  return (
    `<fieldset data-photo-field="${esc(name)}"><legend>${esc(legend)}</legend>` +
    // Revealed by mountPhotos() only on a native build with the camera plugin.
    `<div data-photo-native hidden><div class="actions">` +
    `<button type="button" class="btn secondary" data-photo="camera">Take photo</button>` +
    `<button type="button" class="btn secondary" data-photo="library">Choose from library</button>` +
    `</div></div>` +
    `<div data-photo-web>${field(`${label} (up to ${max})`, name, "file", "", `accept="${ACCEPT}" multiple`)}</div>` +
    `<p class="hint">Photos are resized on this device before they are sent, so a full-resolution camera photo still uploads.</p>` +
    `<ul data-photo-list style="list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px"></ul>` +
    `<p class="form-error" role="alert" data-photo-error hidden></p></fieldset>`
  );
}

const readable = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// Wires the field rendered by photoField(). Returns a controller whose
// files() resolves to the upload-ready File list — preparation started when
// each photo was added, so submitting waits only for what is still running.
export function mountPhotos(scope, { name = "photos", max = 12 } = {}) {
  const root = scope?.querySelector(`[data-photo-field="${name}"]`);
  if (!root) return { files: async () => [], count: () => 0 };
  const list = root.querySelector("[data-photo-list]");
  const problem = root.querySelector("[data-photo-error]");
  const input = root.querySelector(`input[type=file][name="${name}"]`);
  const items = [];
  let sequence = 0;
  const report = (message) => {
    problem.textContent = message;
    problem.hidden = !message;
  };
  const draw = () => {
    list.innerHTML = items
      .map(
        (item) =>
          `<li style="display:flex;align-items:center;gap:8px;border:1px solid var(--line);padding:6px">` +
          (item.preview
            ? `<img src="${item.preview}" alt="" width="44" height="44" style="object-fit:cover;flex:none">`
            : "") +
          `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</span>` +
          `<small style="color:var(--muted)">${esc(item.note)}</small>` +
          `<button type="button" class="btn text" data-photo-remove="${item.id}" aria-label="Remove ${esc(item.name)}">Remove</button></li>`,
      )
      .join("");
  };
  const add = (source) => {
    if (items.length >= max) {
      report(`Attach at most ${max} photos to one report.`);
      return;
    }
    report("");
    const item = {
      id: ++sequence,
      name: source.name || "Photo",
      preview: "",
      note: "Preparing…",
      ready: null,
    };
    item.ready = preparePhoto(source).then((result) => {
      item.name = result.file.name || item.name;
      item.preview = result.preview;
      item.note =
        result.file.size < source.size
          ? `${readable(source.size)} → ${readable(result.file.size)}`
          : readable(result.file.size);
      draw();
      return result.file;
    });
    // Surface the failure in the list; files() still rejects so the report
    // is never saved with a photo silently missing.
    item.ready.catch((error) => {
      item.note = error.message;
      draw();
    });
    items.push(item);
    draw();
  };
  if (input)
    input.addEventListener("change", () => {
      for (const file of input.files) add(file);
      // Clearing lets the same photo be picked again after it was removed.
      input.value = "";
    });
  cameraAvailable()
    .then((available) => {
      if (!available) return;
      root.querySelector("[data-photo-native]").hidden = false;
      root.querySelector("[data-photo-web]").hidden = true;
    })
    .catch(() => {});
  root.addEventListener("click", async (event) => {
    const remove = event.target.closest("[data-photo-remove]");
    if (remove) {
      const at = items.findIndex(
        (item) => item.id === Number(remove.dataset.photoRemove),
      );
      if (at >= 0) items.splice(at, 1);
      report("");
      draw();
      return;
    }
    const take = event.target.closest("[data-photo]");
    if (!take) return;
    take.disabled = true;
    try {
      const photo = await capture(take.dataset.photo);
      if (photo) add(photo);
    } catch (error) {
      report(error.message);
    } finally {
      take.disabled = false;
    }
  });
  return {
    files: async () => {
      const ready = [];
      for (const item of items) ready.push(await item.ready);
      return ready.filter(Boolean);
    },
    count: () => items.length,
  };
}
