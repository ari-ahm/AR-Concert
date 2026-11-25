import { SpatialAudio } from "./audio.js";
import { createMap } from "./map.js";
import { startTracking } from "./tracking.js";
import { startSelfie } from "./selfie.js";

const $ = (id) => document.getElementById(id);
const engine = new SpatialAudio();
const initialPose = () => ({
  position: [0, 0, 0],
  forward: [0, 0, -1],
  up: [0, 1, 0],
});
const defaultRoom = () => ({
  width: 5.2,
  height: 2.8,
  depth: 4.5,
  center: [0, -0.16, -0.6],
  material: $("material").value,
});
let listener = initialPose(),
  room = defaultRoom(),
  planes = [],
  selected = 1,
  seq = 2;
let sources = [
  {
    id: 1,
    label: "Speaker 1",
    channel: "left",
    position: [-1.45, -0.12, -1.35],
  },
  {
    id: 2,
    label: "Speaker 2",
    channel: "right",
    position: [1.45, -0.12, -1.35],
  },
];
let scanMap = null,
  session = null,
  scanned = false,
  starting = false,
  origin = [0, 0, 0],
  scope = 0;
const map = createMap(
  $("map"),
  () => ({ sources, listener, planes, room, selected }),
  select,
);
function attachScanMap(kind) {
  const root = document.querySelector(kind === "xr" ? ".rt-xr" : ".cam");
  if (!root) return;
  const panel = document.createElement("div");
  panel.className = "scan-inset";
  panel.hidden = true;
  const viewport = document.createElement("canvas");
  viewport.setAttribute("aria-label", "Live orbitable room map");
  panel.append(viewport);
  const toggle = document.createElement("button");
  toggle.textContent = "Map";
  toggle.setAttribute("aria-expanded", "false");
  root.querySelector(kind === "xr" ? "footer" : ".camhud").append(toggle);
  root.append(panel);
  const inset = createMap(
    viewport,
    () => ({ sources, listener, planes, room, selected }),
    select,
  );
  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    inset.refresh();
  };
  return inset;
}
function notice(message) {
  $("notice").textContent = message;
}
function audioSources() {
  engine.setSpeakers(
    sources.map((s) => ({
      id: s.id,
      x: s.position[0],
      y: s.position[1],
      z: s.position[2],
      channel: s.channel,
    })),
  );
  map.refresh();
}
function move(id, p) {
  const s = sources.find((s) => s.id === id);
  if (s) {
    s.position = p.slice();
    audioSources();
  }
}
function add(p) {
  if (sources.length >= 12) {
    notice(
      "All 12 speaker positions are in use. Remove a speaker to add another.",
    );
    return null;
  }
  const id = ++seq;
  sources.push({
    id,
    position: p.slice(),
    channel: "mix",
    label: "Speaker " + id,
  });
  selected = id;
  audioSources();
  renderList();
  return id;
}
function select(id) {
  selected = id;
  renderList();
  map.refresh();
}
function renderList(open = false) {
  $("sources").replaceChildren();
  $("editor").replaceChildren();
  for (const s of sources) {
    const b = document.createElement("button");
    b.className = "source";
    b.setAttribute("aria-pressed", s.id === selected);
    b.innerHTML =
      '<span class="speakericon" aria-hidden="true">◉</span><strong>' +
      s.label +
      "</strong><small>" +
      { left: "Left", right: "Right", mix: "L + R" }[s.channel] +
      "</small>";
    b.onclick = () => select(s.id);
    $("sources").append(b);
  }
  const s = sources.find((item) => item.id === selected);
  if (!s) return;
  const details = document.createElement("details");
  details.open = open;
  details.innerHTML = "<summary>Edit " + s.label.toLowerCase() + "</summary>";
  ["X", "Y", "Z"].forEach((axis, i) => {
    const label = document.createElement("label");
    label.className = "axis";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = Math.min(-10, Math.floor(s.position[i]));
    slider.max = Math.max(10, Math.ceil(s.position[i]));
    slider.step = ".05";
    slider.value = s.position[i];
    const output = document.createElement("output");
    output.value = s.position[i].toFixed(1) + " m";
    slider.oninput = () => {
      s.position[i] = Number(slider.value);
      output.value = s.position[i].toFixed(1) + " m";
      audioSources();
    };
    label.append(axis, slider, output);
    details.append(label);
  });
  const remove = document.createElement("button");
  remove.className = "remove";
  remove.textContent = "Remove speaker";
  remove.onclick = () => {
    sources = sources.filter((item) => item.id !== s.id);
    selected = sources.at(-1)?.id;
    audioSources();
    renderList();
  };
  details.append(remove);
  $("editor").append(details);
}
function updateGeometry(next) {
  planes = next;
  // Fit a rectangular late-reverb approximation around measured geometry.
  // Only replace a boundary if an approximately axis-aligned plane supports it.
  const defaults = defaultRoom(),
    ext = [defaults.width, defaults.height, defaults.depth];
  const center = defaults.center.map((v, i) => v + origin[i]);
  const low = center.map((v, i) => v - ext[i] / 2),
    high = center.map((v, i) => v + ext[i] / 2);
  const bounds = [[], [], []];
  for (const p of next) {
    const axis = p.normal
      .map(Math.abs)
      .indexOf(Math.max(...p.normal.map(Math.abs)));
    if (Math.abs(p.normal[axis]) > 0.91) bounds[axis].push(p.point[axis]);
  }
  bounds.forEach((points, i) => {
    const left = points.filter((x) => x < origin[i] - 0.2),
      right = points.filter((x) => x > origin[i] + 0.2);
    if (left.length) low[i] = Math.min(...left);
    if (right.length) high[i] = Math.max(...right);
    if (left.length && !right.length)
      high[i] = Math.max(high[i], low[i] + ext[i]);
    if (right.length && !left.length)
      low[i] = Math.min(low[i], high[i] - ext[i]);
  });
  const quantize = (v) => Math.round(v * 10) / 10;
  const dims = high.map((v, i) => Math.max(0.6, quantize(v - low[i])));
  const fit = {
    width: dims[0],
    height: dims[1],
    depth: dims[2],
    center: low.map((v, i) => quantize((v + high[i]) / 2)),
    material: $("material").value,
  };
  if (JSON.stringify(fit) !== JSON.stringify(room)) {
    room = fit;
    engine.setRoom(room);
  }
  engine.setSurfaces(next);
  map.refresh();
  const n = planes.length;
  $("surfacecount").textContent =
    (n ? "Fitted enclosure" : "Estimated enclosure") +
    " · " +
    n +
    " observed surface" +
    (n === 1 ? "" : "s");
}
function newCoordinates(p) {
  // Preserve the mix, bringing its layout into the new session relative to its entry pose.
  const f = p.forward,
    len = Math.hypot(f[0], f[2]),
    fx = len > 0.01 ? f[0] / len : 0,
    fz = len > 0.01 ? f[2] / len : -1;
  for (const s of sources) {
    const [x, y, z] = s.position.map((v, i) => v - origin[i]);
    s.position = [
      p.position[0] - fz * x - fx * z,
      p.position[1] + y,
      p.position[2] + fx * x - fz * z,
    ];
  }
  origin = p.position.slice();
  audioSources();
  updateGeometry([]);
  renderList();
}
async function toggle() {
  try {
    if (engine.media.paused) await engine.play();
    else engine.pause();
  } catch (e) {
    notice(e.message);
  }
}
async function begin(kind) {
  if (starting || session) return;
  starting = true;
  const token = ++scope;
  let first = true;
  $("setupmessage").textContent =
    "Starting " + (kind === "xr" ? "room tracking" : "selfie tracking") + "…";
  $("xr").disabled = $("marker").disabled = true;
  try {
    const callbacks = {
      getSources: () => sources,
      onAdd: add,
      onMove: move,
      onSelect: select,
      onPlay: toggle,
      onPose: (p) => {
        if (token !== scope) return;
        if (first) {
          first = false;
          newCoordinates(p);
        }
        listener = p;
        engine.setListener(p);
        map.refresh();
        scanMap?.refresh();
      },
      onPlanes: (next) => {
        if (token === scope && !first) updateGeometry(next);
      },
      onStatus: notice,
      onEnd: () => {
        if (token !== scope) return;
        scope++;
        scanMap?.dispose();
        scanMap = null;
        session = null;
        $("mode").textContent = scanned ? "LAST SCAN" : "PREVIEW";
        $("start").textContent = "◎   Start room scan";
        renderList();
        notice("Scan ended. Inspect the room map or continue listening here.");
      },
    };
    const controller = await (kind === "xr"
      ? startTracking(callbacks)
      : startSelfie(callbacks));
    if (scope !== token) {
      await controller.stop();
      return;
    }
    session = controller;
    scanMap = attachScanMap(kind);
    scanned = true;
    $("setup").close();
    $("mode").textContent = "LIVE SCAN";
    $("start").textContent = "End scan";
  } catch (e) {
    $("setupmessage").textContent =
      e.message || "Camera tracking could not start.";
    notice($("setupmessage").textContent);
  } finally {
    starting = false;
    $("xr").disabled = $("marker").disabled = false;
  }
}
$("guide").onclick = () => $("manual").showModal();
$("start").onclick = () => {
  if (session) {
    session.stop();
    return;
  }
  $("setupmessage").textContent = "";
  $("setup").showModal();
};
$("xr").onclick = () => begin("xr");
$("marker").onclick = () => begin("marker");
$("material").onchange = () => {
  room.material = $("material").value;
  engine.setRoom(room);
};
$("add").onclick = () => {
  const angle = seq * 2.4;
  add([
    listener.position[0] + Math.sin(angle) * 1.4,
    listener.position[1] - 0.1,
    listener.position[2] + Math.cos(angle) * 1.4,
  ]);
};
$("zin").onclick = () => map.zoom(0.15);
$("zout").onclick = () => map.zoom(-0.15);
$("homeview").onclick = () => map.reset();
$("file").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  engine.load(f);
  $("trackname").textContent = f.name;
  $("play").disabled = false;
  notice("Ready to play · Audio stays on this device.");
};
$("play").onclick = toggle;
const stamp = (t) =>
  Math.floor((t || 0) / 60) +
  ":" +
  String(Math.floor((t || 0) % 60)).padStart(2, "0");
function mediaState() {
  const m = engine.media,
    d = Number.isFinite(m.duration) ? m.duration : 0;
  $("time").textContent = stamp(m.currentTime) + " / " + stamp(d);
  $("seek").disabled = !d;
  $("seek").value = d ? (1000 * m.currentTime) / d : 0;
  $("play").textContent = m.paused ? "▶" : "Ⅱ";
  $("play").setAttribute("aria-label", m.paused ? "Play" : "Pause");
}
for (const ev of [
  "timeupdate",
  "loadedmetadata",
  "pause",
  "play",
  "ended",
  "durationchange",
])
  engine.media.addEventListener(ev, mediaState);
engine.media.addEventListener("error", () => {
  notice("This audio file could not be decoded. Try MP3, AAC, or WAV.");
  $("play").disabled = true;
});
$("seek").oninput = (e) =>
  engine.seek((engine.media.duration * Number(e.target.value)) / 1000);
engine.setRoom(room);
audioSources();
renderList();
mediaState();
