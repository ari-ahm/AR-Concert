import { cameraSampler } from "./xr-camera.js";
import { SampledSurfaces } from "./surface-map.js";

const magnitude = (v) => Math.hypot(...v);
const minus = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const normalize = (a) => a.map((v) => v / (magnitude(a) || 1));
const along = (origin, ray, distance) =>
  origin.map((v, i) => v + ray[i] * distance);
const xyz = (point) => [point.x, point.y, point.z];
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));

function transform(matrix, v, w = 1) {
  return [0, 1, 2, 3].map(
    (i) =>
      matrix[i] * v[0] +
      matrix[i + 4] * v[1] +
      matrix[i + 8] * v[2] +
      matrix[i + 12] * w,
  );
}

export function projectPoint(view, point) {
  const local = transform(view.transform.inverse.matrix, point);
  const [x, y, , w] = transform(view.projectionMatrix, local);
  return w > 0.04 ? { x: (x / w + 1) / 2, y: (1 - y / w) / 2, depth: w } : null;
}

export function viewRay(view, x, y) {
  const p = view.projectionMatrix;
  const local = [(2 * x - 1 + p[8]) / p[0], (1 - 2 * y + p[9]) / p[5], -1];
  return normalize(transform(view.transform.matrix, local, 0).slice(0, 3));
}

function insidePolygon(point, vertices, normal) {
  if (!vertices.length) return false;
  // Project onto the plane's largest-area coordinate pair.
  const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  const u = (drop + 1) % 3,
    v = (drop + 2) % 3;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i],
      b = vertices[j];
    if (
      a[v] > point[v] !== b[v] > point[v] &&
      point[u] < ((b[u] - a[u]) * (point[v] - a[v])) / (b[v] - a[v]) + a[u]
    )
      inside = !inside;
  }
  return inside;
}

function projectOutline(view, vertices) {
  // Clip polygons crossing the listener before the perspective divide.
  const clip = vertices.map((v) =>
    transform(
      view.projectionMatrix,
      transform(view.transform.inverse.matrix, v),
    ),
  );
  const visible = [];
  for (let i = 0; i < clip.length; i++) {
    const a = clip[(i + clip.length - 1) % clip.length],
      b = clip[i];
    if (a[3] >= 0.05 !== b[3] >= 0.05) {
      const t = (0.05 - a[3]) / (b[3] - a[3]);
      visible.push(a.map((n, k) => n + t * (b[k] - n)));
    }
    if (b[3] >= 0.05) visible.push(b);
  }
  return visible.map((p) => ({
    x: (1 + p[0] / p[3]) / 2,
    y: (1 - p[1] / p[3]) / 2,
  }));
}

function makeOverlay() {
  if (!document.querySelector("link[data-roomtone-xr]")) {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = new URL("./tracking.css", import.meta.url);
    style.dataset.roomtoneXr = "";
    document.head.append(style);
  }
  const root = document.createElement("section");
  root.className = "rt-xr";
  root.hidden = true;
  root.innerHTML = `<canvas aria-label="Tracked room and speakers"></canvas>
    <header><output>Finding room features…</output><button data-kind="exit">End AR</button></header>
    <footer><p>Move the phone slowly across the room. Double-tap a surface to add a speaker or drag a speaker to move it.</p>
    <button data-kind="place">Place speaker</button><button data-kind="play">Play / pause</button></footer>`;
  document.body.append(root);
  root.addEventListener("beforexrselect", (event) => event.preventDefault());
  return root;
}

export async function startTracking({
  getSources,
  onAdd,
  onMove,
  onPose,
  onPlanes = () => {},
  onSelect = () => {},
  onStatus = () => {},
  onEnd = () => {},
  onPlay,
}) {
  if (!globalThis.isSecureContext)
    throw new Error("Room tracking needs HTTPS or localhost.");
  if (!navigator.xr)
    throw new Error(
      "This browser has no immersive AR. Use Chrome on an ARCore-compatible Android phone, or choose selfie tracking.",
    );
  const overlay = makeOverlay();
  let session;
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test", "dom-overlay"],
      optionalFeatures: ["anchors", "plane-detection", "camera-access"],
      domOverlay: { root: overlay },
    });
  } catch (err) {
    overlay.remove();
    if (err.name === "NotSupportedError")
      throw new Error(
        "Room AR needs hit testing and a camera overlay. Try Chrome on an ARCore-compatible Android phone.",
      );
    if (err.name === "NotAllowedError" || err.name === "SecurityError")
      throw new Error(
        "Room AR access was declined or blocked. Open the app directly over HTTPS and allow AR access.",
      );
    throw err;
  }

  const canvas = overlay.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const status = overlay.querySelector("output");
  const help = overlay.querySelector("p");
  const play = overlay.querySelector("[data-kind=play]");
  play.hidden = !onPlay;
  play.onclick = onPlay;
  const gl = document
    .createElement("canvas")
    .getContext("webgl2", { alpha: true, xrCompatible: true });
  let ended = false,
    initialized = false;
  let hits,
    space,
    current,
    hit,
    sampler,
    detector,
    detectorRequested = false;
  let lastHand = -Infinity,
    lastPlane = -Infinity,
    lastHitSample = -Infinity;
  const observations = new SampledSurfaces();
  let planes = [],
    grab,
    handCursor,
    pendingAnchor;
  let lastTouch = null,
    touchId;
  const anchors = new Map();
  const pending = new Map();
  const finish = () => {
    if (ended) return;
    ended = true;
    hits?.cancel();
    sampler?.close();
    detector?.close();
    for (const anchor of anchors.values()) anchor.delete();
    anchors.clear();
    pending.clear();
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    overlay.remove();
    if (initialized) onEnd();
  };
  session.addEventListener("end", finish, { once: true });
  const stop = () => (ended ? Promise.resolve() : session.end());
  overlay.querySelector("[data-kind=exit]").onclick = stop;
  function report(text) {
    if (status.textContent === text) return;
    status.textContent = text;
    onStatus(text);
  }
  let base;
  try {
    if (!gl || !ctx)
      throw new Error("The browser could not create the AR graphics surface.");
    await gl.makeXRCompatible();
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    base = await session.requestReferenceSpace("local");
    const viewer = await session.requestReferenceSpace("viewer");
    hits = await session.requestHitTestSource({
      space: viewer,
      entityTypes: ["plane"],
    });
    if (!hits || ended)
      throw new Error("Room tracking ended before the scanner was ready.");
  } catch (err) {
    try {
      await stop();
    } finally {
      finish();
    }
    throw err;
  }
  initialized = true;
  overlay.hidden = false;
  // A new local origin invalidates all saved positions. End so the caller can
  // return the user to their editor instead of placing sources at stale poses.
  base.addEventListener("reset", () => {
    onStatus("The room origin changed. Start a new scan.");
    stop();
  });

  function at(x, y) {
    if (!current) return null;
    const ray = viewRay(current.view, x, y);
    let nearest = Infinity,
      normal;
    for (const plane of planes) {
      const divisor = dot(ray, plane.normal);
      if (Math.abs(divisor) < 0.005) continue;
      const distance =
        dot(minus(plane.point, current.position), plane.normal) / divisor;
      if (distance < 0.12 || distance > 12 || distance >= nearest) continue;
      if (
        insidePolygon(
          along(current.position, ray, distance),
          plane.vertices,
          plane.normal,
        )
      ) {
        nearest = distance;
        normal = plane.normal;
      }
    }
    const offsetDriver = (point, direction) =>
      along(point, direction, dot(direction, ray) > 0 ? -0.12 : 0.12);
    if (nearest !== Infinity)
      return offsetDriver(along(current.position, ray, nearest), normal);
    if (hit && Math.hypot(x - 0.5, y - 0.5) < 0.06)
      return offsetDriver(hit.point, hit.normal);
    return along(current.position, ray, 1.35);
  }
  function pick(x, y) {
    if (!current) return null;
    let choice = null,
      best = 44;
    for (const source of getSources()) {
      const screen = projectPoint(current.view, source.position);
      if (!screen) continue;
      const dist = Math.hypot(
        (screen.x - x) * canvas.clientWidth,
        (screen.y - y) * canvas.clientHeight,
      );
      if (dist < best) {
        best = dist;
        choice = source;
      }
    }
    return choice;
  }
  function add(x = 0.5, y = 0.5) {
    const point = at(x, y);
    if (!point) return;
    const id = onAdd(point);
    if (id != null) pendingAnchor = { id, point };
    else
      help.textContent =
        "Speaker limit reached. Remove a speaker in the studio to add another.";
  }
  function startGrab(source, x, y, width, kind) {
    anchors.get(source.id)?.delete();
    anchors.delete(source.id);
    pending.delete(source.id);
    if (pendingAnchor?.id === source.id) pendingAnchor = null;
    const distance = magnitude(minus(source.position, current.position));
    grab = {
      id: source.id,
      distance,
      width,
      kind,
      point: source.position,
      offset: minus(
        source.position,
        along(current.position, viewRay(current.view, x, y), distance),
      ),
    };
    onSelect(source.id);
  }
  function drag(x, y, width) {
    if (!grab || !current) return;
    const ratio = width && grab.width ? grab.width / width : 1;
    const projected = along(
      current.position,
      viewRay(current.view, x, y),
      clamp(grab.distance * ratio, 0.15, 12),
    );
    const next = projected.map((v, i) => v + grab.offset[i]);
    grab.point =
      grab.kind === "hand"
        ? grab.point.map((v, i) => v + 0.55 * (next[i] - v))
        : next;
    onMove(grab.id, grab.point);
  }
  function release() {
    if (grab) pendingAnchor = { id: grab.id, point: grab.point.slice() };
    grab = undefined;
  }
  function useHand(sample) {
    handCursor = sample;
    if (!sample || !current || touchId != null) {
      if (grab?.kind === "hand") release();
      return;
    }
    const { x, y, palmWidth } = sample;
    if (sample.phase === "start") {
      const source = pick(x, y);
      if (source) startGrab(source, x, y, palmWidth, "hand");
      else if (sample.doublePinch) add(x, y);
    } else if (sample.phase === "hold" && grab?.kind === "hand")
      drag(x, y, palmWidth);
    else if (grab?.kind === "hand") release();
  }
  function coords(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    ];
  }
  canvas.onpointerdown = (e) => {
    if (touchId != null || !current) return;
    touchId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    release();
    const [x, y] = coords(e),
      source = pick(x, y);
    if (source) {
      lastTouch = null;
      startGrab(source, x, y, null, "touch");
    } else if (
      lastTouch &&
      e.timeStamp - lastTouch.time < 450 &&
      Math.hypot(e.clientX - lastTouch.x, e.clientY - lastTouch.y) < 45
    ) {
      add(x, y);
      lastTouch = null;
    } else lastTouch = { x: e.clientX, y: e.clientY, time: e.timeStamp };
  };
  canvas.onpointermove = (e) => {
    if (e.pointerId === touchId && grab?.kind === "touch") drag(...coords(e));
  };
  canvas.onpointerup = canvas.onpointercancel = (e) => {
    if (touchId !== e.pointerId) return;
    touchId = undefined;
    release();
  };
  overlay.querySelector("[data-kind=place]").onclick = () => add();

  function surface(matrix, vertices = [], orientation) {
    const point = [matrix[12], matrix[13], matrix[14]];
    const normal = normalize([matrix[4], matrix[5], matrix[6]]);
    return {
      point,
      normal,
      vertices,
      orientation:
        orientation ||
        (Math.abs(normal[1]) < 0.2
          ? "vertical"
          : Math.abs(normal[1]) > 0.9
            ? "horizontal"
            : null),
    };
  }

  function updateSurfaces(frame, time) {
    const result = frame.getHitTestResults(hits)[0]?.getPose(space);
    hit = result ? surface(result.transform.matrix) : null;
    if (hit && time - lastHitSample > 140 && !frame.detectedPlanes?.size) {
      lastHitSample = time;
      observations.update(hit);
    }
    if (time - lastPlane < 350) return;
    lastPlane = time;
    if (frame.detectedPlanes?.size) {
      planes = [];
      for (const plane of frame.detectedPlanes) {
        const pose = frame.getPose(plane.planeSpace, space);
        if (!pose) continue;
        const matrix = pose.transform.matrix;
        const vertices = Array.from(plane.polygon, (p) =>
          transform(matrix, xyz(p)).slice(0, 3),
        );
        if (vertices.length >= 3)
          planes.push({
            ...surface(matrix, vertices, plane.orientation),
            source: "detected",
            estimated: false,
          });
      }
    } else planes = observations.planes;
    onPlanes(planes);
  }

  function updateAnchors(frame) {
    if (pendingAnchor) {
      const { id, point } = pendingAnchor;
      pendingAnchor = null;
      if (frame.createAnchor) {
        const token = {};
        pending.set(id, token);
        frame
          .createAnchor(
            new XRRigidTransform({ x: point[0], y: point[1], z: point[2] }),
            space,
          )
          .then((anchor) => {
            if (ended || pending.get(id) !== token) {
              anchor.delete();
              return;
            }
            anchors.get(id)?.delete();
            anchors.set(id, anchor);
          })
          .catch(() => {})
          .finally(() => {
            if (pending.get(id) === token) pending.delete(id);
          });
      }
    }
    for (const [id, anchor] of anchors) {
      const source = getSources().find((s) => s.id === id);
      if (!source) {
        anchor.delete();
        anchors.delete(id);
        continue;
      }
      const pose = frame.getPose(anchor.anchorSpace, space);
      if (pose) {
        const next = xyz(pose.transform.position);
        if (magnitude(minus(next, source.position)) > 0.005) onMove(id, next);
      }
    }
  }
  function loadDetector() {
    if (detectorRequested) return;
    detectorRequested = true;
    help.textContent =
      "Loading hand gestures. You can place speakers with touch.";
    import("./hands.js")
      .then((m) => m.createHandTracker())
      .then((model) => {
        if (ended) {
          model.close();
          return;
        }
        detector = model;
        help.textContent =
          "Double-pinch in empty space to add. Pinch a speaker and move your hand or phone to carry it.";
      })
      .catch(() => {
        help.textContent =
          "Hand tracking could not load. Double-tap to place a speaker or drag one to move it.";
      });
  }
  function updateHands(frame, time, view) {
    if (time - lastHand < 75) return;
    lastHand = time;
    if (!view.camera || typeof XRWebGLBinding === "undefined") {
      detector?.reset();
      useHand(null);
      return;
    }
    loadDetector();
    if (!detector) return;
    try {
      sampler ??= cameraSampler(gl, session);
      const image = sampler.sample(view.camera);
      useHand(image ? detector.detect(image, time) : null);
    } catch {
      detector.close();
      detector = null;
      useHand(null);
      help.textContent =
        "Hand tracking is unavailable. Double-tap to place a speaker or drag one to move it.";
    }
  }
  function draw() {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (
      canvas.width !== Math.round(w * dpr) ||
      canvas.height !== Math.round(h * dpr)
    ) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!current) return;
    for (const plane of planes) {
      if (plane.vertices.length < 3) continue;
      const outline = projectOutline(current.view, plane.vertices);
      if (outline.length < 3) continue;
      ctx.beginPath();
      outline.forEach((p, i) =>
        i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h),
      );
      ctx.closePath();
      ctx.fillStyle = "rgba(196,251,117,.07)";
      ctx.fill();
      ctx.strokeStyle = "rgba(220,255,170,.65)";
      ctx.lineWidth = 1;
      ctx.setLineDash(plane.estimated ? [5, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const drawCircle = (x, y, r, fill, stroke) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    drawCircle(
      w / 2,
      h / 2,
      hit ? 8 : 4,
      "#16202477",
      hit ? "#e0ff91" : "#fff",
    );
    const sources = getSources();
    sources
      .map((s, i) => ({ s, i, p: projectPoint(current.view, s.position) }))
      .filter(({ p }) => p)
      .sort((a, b) => b.p.depth - a.p.depth)
      .forEach(({ s, i, p }) => {
        const x = p.x * w,
          y = p.y * h,
          r = clamp(26 / Math.sqrt(p.depth), 15, 33);
        drawCircle(
          x,
          y,
          r,
          "#16211be8",
          grab?.id === s.id ? "#fff" : "#d5f973",
        );
        ctx.fillStyle = "#edffaf";
        ctx.font = "600 15px system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(s.id ?? i + 1).padStart(2, "0"), x, y);
      });
    if (handCursor)
      drawCircle(
        handCursor.x * w,
        handCursor.y * h,
        handCursor.pinched ? 8 : 5,
        "#e8fa91cc",
        "#23301d",
      );
  }

  function render(time, frame) {
    if (ended) return;
    session.requestAnimationFrame(render);
    if (!space) {
      const origin = frame.getViewerPose(base);
      if (origin && !origin.emulatedPosition) {
        const m = origin.transform.matrix,
          yaw = Math.atan2(m[8], m[10]);
        space = base.getOffsetReferenceSpace(
          new XRRigidTransform(origin.transform.position, {
            x: 0,
            y: Math.sin(yaw / 2),
            z: 0,
            w: Math.cos(yaw / 2),
          }),
        );
      }
    }
    const pose = space && frame.getViewerPose(space);
    const layer = session.renderState.baseLayer;
    if (layer) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    if (!pose || pose.emulatedPosition || !pose.views.length) {
      current = null;
      hit = null;
      release();
      handCursor = null;
      detector?.reset();
      report("Tracking paused · slowly scan textured surfaces");
      draw();
      return;
    }
    const m = pose.transform.matrix;
    current = { view: pose.views[0], position: xyz(pose.transform.position) };
    onPose({
      position: current.position,
      forward: [-m[8], -m[9], -m[10]],
      up: [m[4], m[5], m[6]],
    });
    updateSurfaces(frame, time);
    updateAnchors(frame);
    updateHands(frame, time, current.view);
    const mapping = planes.length
      ? planes.length +
        (planes[0].estimated ? " sampled patches" : " tracked planes")
      : "sweep across walls";
    report((hit ? "Surface found · " : "Tracking · ") + mapping);
    draw();
  }
  session.requestAnimationFrame(render);
  return { stop, place: add };
}
