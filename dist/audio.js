// All sources share the same media element and audio clock. World coordinates
// use WebXR conventions. Resonance's rectangular room has a centered origin.
const presets = {
  studio: ["curtain-heavy", "acoustic-ceiling-tiles", "wood-panel", 0.3],
  living: ["sheetrock", "plaster-smooth", "parquet-on-concrete", 0.62],
  hall: ["brick-bare", "plaster-smooth", "polished-concrete-or-tile", 0.82],
  dry: ["transparent", "transparent", "transparent", 0],
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const validVector = (v) =>
  v?.length === 3 && Array.from(v).every(Number.isFinite);
const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
const degrees = 180 / Math.PI;
const speedOfSound = 343;

function insidePolygon(p, vertices, axes) {
  const [x, y] = axes;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i],
      b = vertices[j];
    if (a[y] > p[y] === b[y] > p[y]) continue;
    const crossing = a[x] + ((p[y] - a[y]) * (b[x] - a[x])) / (b[y] - a[y]);
    if (p[x] < crossing) inside = !inside;
  }
  return inside;
}

// Mirror the source through the plane. A reflected path exists only if the
// listener-to-image segment actually intersects the observed surface patch.
function reflection(source, listener, surface) {
  const { point, normal, vertices, axes } = surface;
  const s = dot(subtract(source, point), normal);
  const l = dot(subtract(listener, point), normal);
  if (s * l <= 0.00001) return null;
  const ray = source.map((v, i) => v - 2 * s * normal[i] - listener[i]);
  const fraction = l / (l + s);
  const bounce = listener.map((v, i) => v + fraction * ray[i]);
  if (!insidePolygon(bounce, vertices, axes)) return null;
  const distance = Math.hypot(...ray);
  if (distance >= speedOfSound || distance < 0.001) return null;
  return { distance, ray };
}

function normalizeSurface({ point, normal, vertices }) {
  if (
    !validVector(point) ||
    !validVector(normal) ||
    !vertices?.every(validVector) ||
    vertices.length < 3
  )
    return null;
  const length = Math.hypot(...normal);
  if (length < 0.001) return null;
  const axes = [0, 1, 2]
    .sort((a, b) => Math.abs(normal[a]) - Math.abs(normal[b]))
    .slice(0, 2);
  return {
    point,
    normal: Array.from(normal, (v) => v / length),
    vertices,
    axes,
  };
}

function materialsFor(material) {
  const [wall, up, down] = presets[material];
  return { left: wall, right: wall, front: wall, back: wall, up, down };
}

function smooth(parameter, target, time, seconds = 0.025) {
  parameter.setTargetAtTime(target, time, seconds);
}

// The SDK applies this rotation to the sound field. The room must rotate by
// the inverse camera rotation when the listener turns. Transpose the camera
// basis [right, up, -forward] and extract its forward and up columns.
function orientField(scene, forward, up) {
  const right = [
    forward[1] * up[2] - forward[2] * up[1],
    forward[2] * up[0] - forward[0] * up[2],
    forward[0] * up[1] - forward[1] * up[0],
  ];
  scene.setListenerOrientation(
    -right[2],
    -up[2],
    forward[2],
    right[1],
    up[1],
    -forward[1],
  );
}

export class SpatialAudio {
  constructor() {
    this.media = new Audio();
    this.media.preload = "metadata";
    this.media.setAttribute("playsinline", "");
    this.speakers = [];
    this.surfaces = [];
    this.voices = new Map();
    this.unused = [];
    this.room = {
      width: 5,
      height: 3,
      depth: 6,
      center: [0, 0, 0],
      material: "living",
    };
    this.listener = { position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] };
    this.volume = 0.8;
  }

  load(file) {
    if (!(file instanceof Blob)) throw new TypeError("Choose an audio file.");
    const next = URL.createObjectURL(file);
    this.media.pause();
    this.media.src = next;
    this.media.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = next;
  }

  play() {
    if (!this.media.getAttribute("src"))
      return Promise.reject(new Error("Choose an audio file first."));
    if (!this.context) this.initialize();
    // Both calls must take place during the same user activation on mobile.
    return Promise.all([this.context.resume(), this.media.play()]);
  }

  pause() {
    this.media.pause();
  }

  seek(seconds) {
    if (Number.isFinite(seconds) && Number.isFinite(this.media.duration)) {
      this.media.currentTime = clamp(seconds, 0, this.media.duration);
    }
  }

  initialize() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context || !window.ResonanceAudio)
      throw new Error("Spatial audio could not start in this browser.");
    const ctx = new Context({ latencyHint: "interactive" });
    this.scene = new window.ResonanceAudio(ctx, {
      ambisonicOrder: 1,
      dimensions: this.dimensions(),
      materials: materialsFor(this.room.material),
    });
    this.context = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.ratio.value = 16;
    limiter.knee.value = 2;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;
    this.scene.output.connect(limiter);
    limiter.connect(this.master).connect(ctx.destination);

    const input = ctx.createMediaElementSource(this.media);
    const stereo = ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = "explicit"; // Duplicate mono inputs into the stereo pair.
    const splitter = ctx.createChannelSplitter(2);
    input.connect(stereo).connect(splitter);
    this.feeds = {
      left: ctx.createGain(),
      right: ctx.createGain(),
      mix: ctx.createGain(),
    };
    splitter.connect(this.feeds.left, 0);
    splitter.connect(this.feeds.right, 1);
    this.feeds.mix.channelCount = 1;
    this.feeds.mix.channelCountMode = "explicit";
    stereo.connect(this.feeds.mix);
    this.updateEarlyReflections();
    this.setSpeakers(this.speakers);
    this.setListener(this.listener);
    // Omnitone ignores orientation updates until its embedded HRTFs decode.
    // A stationary listener may never produce another pose event.
    const applyWhenReady = () => {
      if (ctx !== this.context || ctx.state === "closed") return;
      if (this.scene._listener._renderer._isRendererReady) {
        orientField(this.scene, this.listener.forward, this.listener.up);
      } else {
        this.readyTimer = setTimeout(applyWhenReady, 100);
      }
    };
    applyWhenReady();
  }

  setVolume(value) {
    if (!Number.isFinite(value)) return;
    this.volume = clamp(value, 0, 1);
    if (this.master)
      smooth(this.master.gain, this.volume, this.context.currentTime);
  }

  dimensions() {
    const { width, depth, height } = this.room;
    return { width, depth, height };
  }

  setRoom({ width, height, depth, material, center }) {
    const previous = this.room;
    const dimension = (v, prior) =>
      Number.isFinite(v) ? clamp(v, 0.5, 60) : prior;
    this.room = {
      width: dimension(width, previous.width),
      height: dimension(height, previous.height),
      depth: dimension(depth, previous.depth),
      center: validVector(center) ? Array.from(center) : previous.center,
      material: Object.hasOwn(presets, material) ? material : previous.material,
    };
    if (!this.scene) return;
    if (
      ["width", "height", "depth", "material"].some(
        (k) => previous[k] !== this.room[k],
      )
    ) {
      this.scene.setRoomProperties(
        this.dimensions(),
        materialsFor(this.room.material),
      );
    }
    this.setListener(this.listener);
    this.setSpeakers(this.speakers);
  }

  setSurfaces(surfaces) {
    this.surfaces = surfaces.map(normalizeSurface).filter(Boolean);
    if (!this.scene) return;
    this.updateEarlyReflections();
    this.updatePaths();
  }

  updateEarlyReflections() {
    // Pinned Resonance SDK exposes the early room bus through its scene
    // internals. Use measured paths in its place; retain the late reverb.
    smooth(
      this.scene._room.early.output.gain,
      this.surfaces.length ? 0 : 1,
      this.context.currentTime,
    );
  }

  createVoice() {
    const signal = this.context.createGain();
    const directDelay = this.context.createDelay(1);
    const source = this.scene.createSource({ minDistance: 1, maxDistance: 80 });
    signal.connect(directDelay).connect(source.input);
    return { signal, directDelay, source, reflections: [] };
  }

  setSpeakers(speakers) {
    this.speakers = speakers.filter((s) =>
      [s.x, s.y, s.z].every(Number.isFinite),
    );
    if (!this.context) return;
    const ids = new Set(this.speakers.map((s) => s.id));
    for (const [id, voice] of this.voices) {
      if (ids.has(id)) continue;
      this.feeds[voice.channel].disconnect(voice.signal);
      voice.channel = null;
      this.unused.push(voice); // The SDK retains sources. Reuse them on future placements.
      this.voices.delete(id);
    }
    const level = 1 / Math.sqrt(Math.max(this.speakers.length, 1));
    for (const speaker of this.speakers) {
      const voice =
        this.voices.get(speaker.id) || this.unused.pop() || this.createVoice();
      const channel = Object.hasOwn(this.feeds, speaker.channel)
        ? speaker.channel
        : "mix";
      if (voice.channel !== channel) {
        if (voice.channel) this.feeds[voice.channel].disconnect(voice.signal);
        this.feeds[channel].connect(voice.signal);
        voice.channel = channel;
      }
      this.voices.set(speaker.id, voice);
      smooth(voice.signal.gain, level, this.context.currentTime);
      voice.position = [speaker.x, speaker.y, speaker.z];
      voice.source.setPosition(...subtract(voice.position, this.room.center));
    }
    this.updatePaths();
  }

  setListener(pose) {
    if (![pose.position, pose.forward, pose.up].every(validVector)) return;
    this.listener = pose;
    if (!this.scene) return;
    this.scene.setListenerPosition(
      ...subtract(pose.position, this.room.center),
    );
    orientField(this.scene, pose.forward, pose.up);
    this.updatePaths();
  }

  createReflection(signal) {
    const delay = this.context.createDelay(1);
    const level = this.context.createGain();
    level.gain.value = 0;
    const encoder = new window.ResonanceAudio.Encoder(this.context, {
      ambisonicOrder: 1,
    });
    signal.connect(delay).connect(level).connect(encoder.input);
    encoder.output.connect(this.scene.ambisonicInput);
    return { delay, level, encoder };
  }

  updatePaths() {
    const listener = this.listener.position;
    const time = this.context.currentTime;
    const reflectivity = presets[this.room.material][3];
    for (const voice of this.voices.values()) {
      const directDistance = Math.hypot(...subtract(voice.position, listener));
      smooth(
        voice.directDelay.delayTime,
        Math.min(0.99, directDistance / speedOfSound),
        time,
      );
      const paths = this.surfaces
        .map((surface) => reflection(voice.position, listener, surface))
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 4);
      for (
        let i = 0;
        i < Math.max(paths.length, voice.reflections.length);
        i++
      ) {
        const tap = (voice.reflections[i] ??= this.createReflection(
          voice.signal,
        ));
        const path = paths[i];
        if (!path) {
          smooth(tap.level.gain, 0, time);
          continue;
        }
        const [x, y, z] = path.ray;
        tap.encoder.setDirection(
          Math.atan2(-x, z) * degrees,
          Math.atan2(y, Math.hypot(x, z)) * degrees,
        );
        smooth(tap.delay.delayTime, path.distance / speedOfSound, time);
        smooth(tap.level.gain, reflectivity / Math.max(1, path.distance), time);
      }
    }
  }

  dispose() {
    clearTimeout(this.readyTimer);
    this.pause();
    this.media.removeAttribute("src");
    this.media.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.context?.close();
    this.context = this.scene = this.master = null;
    this.voices.clear();
    this.unused.length = 0;
  }
}
