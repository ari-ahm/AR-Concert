import { createHandTracker } from "./hands.js";

// Row-major rotation plus translation, with WebXR's negative-Z viewing axis.
const identity = () => ({
  r: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  p: [0, 0, 0],
});
const dot = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0);
const transpose = (r) => r[0].map((_, i) => r.map((row) => row[i]));
const rotate = (r, p) => r.map((row) => dot(row, p));
const multiply = (a, b) =>
  a.map((row) => transpose(b).map((col) => dot(row, col)));
const apply = (frame, p) => rotate(frame.r, p).map((v, i) => v + frame.p[i]);
const join = (a, b) => ({ r: multiply(a.r, b.r), p: apply(a, b.p) });
const inverse = (a) => {
  const r = transpose(a.r);
  return { r, p: rotate(r, a.p).map((v) => -v) };
};
const spin = (axis, angle) => {
  const a = identity().r,
    i = (axis + 1) % 3,
    j = (axis + 2) % 3;
  a[i][i] = a[j][j] = Math.cos(angle);
  a[i][j] = -Math.sin(angle);
  a[j][i] = Math.sin(angle);
  return a;
};
const deg = Math.PI / 180;
function orientation(e) {
  if (![e.alpha, e.beta, e.gamma].every(Number.isFinite)) return null;
  const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
  const device = multiply(
    multiply(spin(2, e.alpha * deg), spin(0, e.beta * deg)),
    spin(1, e.gamma * deg),
  );
  return multiply(
    multiply(device, spin(2, -screenAngle * deg)),
    spin(1, Math.PI),
  );
}
let libraries;
function loadPose() {
  return (libraries ??= (async () => {
    for (const name of ["cv", "aruco", "svd", "posit2"]) {
      await new Promise((ok, fail) => {
        const script = document.createElement("script");
        script.src = new URL("./vendor/aruco/" + name + ".js", import.meta.url);
        script.onload = ok;
        script.onerror = () => fail(new Error("Wall tracker failed to load."));
        document.head.append(script);
      });
    }
  })().catch((e) => {
    libraries = null;
    throw e;
  }));
}
export function markerTransform(pose) {
  const signs = [1, 1, -1];
  return {
    r: pose.bestRotation.map((row, i) =>
      row.map((v, j) => v * signs[i] * signs[j]),
    ),
    p: pose.bestTranslation.map((v, i) => (signs[i] * v) / 1000),
  };
}
export async function startSelfie({
  getSources,
  onPose,
  onPlanes,
  onEnd,
  onStatus,
  onAdd,
  onMove,
  onSelect,
  onPlay,
}) {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(
      "The selfie camera needs HTTPS or localhost and camera permission.",
    );
  const orientationAccess =
    window.DeviceOrientationEvent?.requestPermission?.().catch(() => "denied");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "user" },
      width: { ideal: 960 },
      height: { ideal: 720 },
    },
    audio: false,
  });
  const root = document.createElement("section");
  root.className = "cam";
  root.innerHTML =
    '<video muted playsinline autoplay></video><canvas aria-label="Wall markers and tracked speakers"></canvas><output class="camstatus"></output><div class="camhud"><button data-place>Place speaker</button><button data-play>Play / pause</button><button data-end>End scan</button></div>';
  const video = root.querySelector("video"),
    overlay = root.querySelector("canvas"),
    ctx = overlay.getContext("2d");
  const frame = document.createElement("canvas"),
    pixels = frame.getContext("2d", { willReadFrequently: true });
  const status = root.querySelector("output"),
    button = root.querySelector("[data-place]");
  const markers = new Map([[0, identity()]]),
    surveyed = new Set();
  let sensor,
    referenceSensor,
    visual,
    active = false,
    closed = false,
    ready = false,
    lastSeen = -Infinity,
    cam,
    model,
    raf,
    grab,
    cursor,
    lastVideo = -1,
    poseAt = -Infinity,
    handAt = -Infinity,
    gestureFailed = false;
  function sensorEvent(e) {
    sensor = orientation(e);
  }
  function stop() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    model?.close();
    root.remove();
    window.removeEventListener("deviceorientation", sensorEvent);
    window.removeEventListener("pagehide", stop);
    if (ready) onEnd();
  }
  let detector,
    posit,
    focal = 0;
  try {
    await loadPose();
    detector = new AR.Detector({ maxHammingDistance: 3 });
    document.body.append(root);
    video.srcObject = stream;
    await video.play();
    if ((await orientationAccess) !== "denied")
      window.addEventListener("deviceorientation", sensorEvent);
    window.addEventListener("pagehide", stop);
    createHandTracker()
      .then((m) => {
        if (closed) m.close();
        else model = m;
      })
      .catch(() => {
        gestureFailed = true;
      });
  } catch (e) {
    stop();
    throw e;
  }
  function setSurfaces() {
    onPlanes(
      [...surveyed].map((id) => {
        const t = markers.get(id);
        return {
          point: t.p.slice(),
          normal: rotate(t.r, [0, 0, 1]),
          source: "marker",
          estimated: false,
          vertices: [
            [-0.075, -0.075, 0],
            [0.075, -0.075, 0],
            [0.075, 0.075, 0],
            [-0.075, 0.075, 0],
          ].map((v) => apply(t, v)),
        };
      }),
    );
  }
  function observe(now) {
    const max = 640,
      scale = max / Math.max(video.videoWidth, video.videoHeight);
    const w = Math.round(video.videoWidth * scale),
      h = Math.round(video.videoHeight * scale);
    if (frame.width !== w || frame.height !== h || !posit) {
      frame.width = overlay.width = w;
      frame.height = overlay.height = h;
      focal = Math.max(w, h) * 0.88;
      posit = new POS.Posit(150, focal);
    }
    pixels.drawImage(video, 0, 0, w, h);
    const found = detector
      .detect(pixels.getImageData(0, 0, w, h))
      .filter((t) => t.id >= 0 && t.id <= 3)
      .flatMap((t) => {
        const corners = t.corners.map((p) => ({
          x: p.x - w / 2,
          y: h / 2 - p.y,
        }));
        const side = Math.hypot(
          corners[0].x - corners[1].x,
          corners[0].y - corners[1].y,
        );
        if (side < 16) return [];
        const pose = posit.pose(corners);
        if (
          !Number.isFinite(pose.bestError) ||
          pose.bestTranslation[2] <= 0 ||
          pose.bestError > 6
        )
          return [];
        return [{ id: t.id, side, rel: markerTransform(pose) }];
      })
      .sort((a, b) => b.side - a.side);
    const ref = found.find((t) => markers.has(t.id));
    if (!ref) return;
    visual = join(markers.get(ref.id), inverse(ref.rel));
    lastSeen = now;
    referenceSensor = sensor;
    let changed = false;
    for (const t of found) {
      if (!markers.has(t.id)) markers.set(t.id, join(visual, t.rel));
      if (!surveyed.has(t.id)) {
        surveyed.add(t.id);
        changed = true;
      }
    }
    if (changed) dirty = true;
  }
  let dirty = false;
  function project(p) {
    const [x, y, z] = apply(inverse(cam), p);
    if (z >= -0.05) return null;
    return {
      x: overlay.width / 2 + (focal * x) / -z,
      y: overlay.height / 2 - (focal * y) / -z,
      depth: -z,
    };
  }
  function point(x, y, depth) {
    return apply(cam, [
      ((x - overlay.width / 2) * depth) / focal,
      ((overlay.height / 2 - y) * depth) / focal,
      -depth,
    ]);
  }
  function pick(x, y) {
    return getSources()
      .map((s) => ({ s, v: project(s.position) }))
      .filter((o) => o.v)
      .map((o) => ({ ...o, dist: Math.hypot(x - o.v.x, y - o.v.y) }))
      .filter((o) => o.dist < 32)
      .sort((a, b) => a.dist - b.dist)[0];
  }
  function place(x = overlay.width / 2, y = overlay.height / 2) {
    if (!active) return;
    onAdd(
      point(x, y, Math.min(1.4, Math.max(0.25, Math.hypot(...cam.p) * 0.7))),
    );
  }
  function useHand(sample) {
    cursor = sample;
    if (!sample || !active) {
      grab = null;
      return;
    }
    const x = sample.x * overlay.width,
      y = sample.y * overlay.height;
    if (sample.phase === "start") {
      const hit = pick(x, y);
      if (hit) {
        grab = { id: hit.s.id, w: sample.palmWidth, depth: hit.v.depth };
        onSelect(grab.id);
      } else if (sample.doublePinch) place(x, y);
    } else if (sample.phase === "hold" && grab) {
      onMove(
        grab.id,
        point(
          x,
          y,
          Math.max(0.15, Math.min(8, (grab.depth * grab.w) / sample.palmWidth)),
        ),
      );
    } else grab = null;
  }
  function paint() {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!cam || !active) return;
    for (const id of surveyed) {
      const tag = markers.get(id),
        outline = [
          [-0.075, -0.075, 0],
          [0.075, -0.075, 0],
          [0.075, 0.075, 0],
          [-0.075, 0.075, 0],
        ].map((p) => project(apply(tag, p)));
      if (outline.some((p) => !p)) continue;
      ctx.beginPath();
      outline.forEach((p, i) =>
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
      );
      ctx.closePath();
      ctx.fillStyle = "#a7eed34a";
      ctx.fill();
      ctx.strokeStyle = "#a7eed3";
      ctx.stroke();
    }
    for (const s of getSources()) {
      const v = project(s.position);
      if (!v) continue;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 15, 0, 2 * Math.PI);
      ctx.fillStyle = "#bd5429";
      ctx.fill();
      ctx.strokeStyle = "white";
      ctx.stroke();
      ctx.fillStyle = "white";
      ctx.font = "bold 14px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(String(s.id), v.x, v.y + 5);
    }
    if (cursor) {
      ctx.beginPath();
      ctx.arc(
        cursor.x * overlay.width,
        cursor.y * overlay.height,
        cursor.pinched ? 8 : 5,
        0,
        2 * Math.PI,
      );
      ctx.fillStyle = "#b5fae0";
      ctx.fill();
    }
  }
  function loop(now) {
    if (closed) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2) return;
    if (now - poseAt >= 65 && video.currentTime !== lastVideo) {
      poseAt = now;
      lastVideo = video.currentTime;
      observe(now);
    }
    active = now - lastSeen < 420;
    if (active) {
      cam = { ...visual };
      if (referenceSensor && sensor)
        cam.r = multiply(
          visual.r,
          multiply(transpose(referenceSensor), sensor),
        );
      // Audio faces the screen. The front-facing optical axis points back at the user.
      onPose({
        position: cam.p,
        forward: rotate(cam.r, [0, 0, 1]),
        up: rotate(cam.r, [0, 1, 0]),
      });
      if (dirty) {
        setSurfaces();
        dirty = false;
      }
      if (model && now - handAt >= 85) {
        handAt = now;
        try {
          useHand(model.detect(video, now));
        } catch {
          model.close();
          model = null;
          gestureFailed = true;
          useHand(null);
        }
      }
    } else {
      grab = null;
      cursor = null;
      model?.reset();
    }
    const info = active
      ? surveyed.size +
        " mapped marker" +
        (surveyed.size === 1 ? "" : "s") +
        " · " +
        (gestureFailed
          ? "touch placement"
          : model
            ? "double-pinch to place"
            : "loading gestures")
      : visual
        ? "Tracking paused · show a known marker"
        : "Show upright marker 0 to the selfie camera";
    if (status.textContent !== info) {
      status.textContent = info;
      onStatus(info);
    }
    button.disabled = !active;
    const size = video.getBoundingClientRect();
    overlay.style.width = size.width + "px";
    overlay.style.height = size.height + "px";
    paint();
  }
  button.onclick = () => place();
  root.querySelector("[data-end]").onclick = stop;
  root.querySelector("[data-play]").onclick = onPlay;
  let touch = null,
    previousTap;
  overlay.onpointerdown = (e) => {
    if (!active) return;
    const rect = overlay.getBoundingClientRect(),
      x = ((e.clientX - rect.left) * overlay.width) / rect.width,
      y = ((e.clientY - rect.top) * overlay.height) / rect.height;
    const hit = pick(x, y);
    if (hit) {
      onSelect(hit.s.id);
      touch = { id: hit.s.id, depth: hit.v.depth };
      overlay.setPointerCapture(e.pointerId);
    } else if (
      previousTap &&
      performance.now() - previousTap.time < 400 &&
      Math.hypot(x - previousTap.x, y - previousTap.y) < 35
    ) {
      place(x, y);
      previousTap = null;
    } else previousTap = { time: performance.now(), x, y };
  };
  overlay.onpointermove = (e) => {
    if (!active || !touch) return;
    const r = overlay.getBoundingClientRect();
    onMove(
      touch.id,
      point(
        ((e.clientX - r.left) / r.width) * overlay.width,
        ((e.clientY - r.top) / r.height) * overlay.height,
        touch.depth,
      ),
    );
  };
  overlay.onpointerup = overlay.onpointercancel = () => (touch = null);
  ready = true;
  raf = requestAnimationFrame(loop);
  return { stop, place };
}
