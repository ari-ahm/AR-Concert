// MediaPipe reports x/y as fractions of width/height. Scale y before comparing
// fingertip distances so the pinch works in both landscape and portrait.
export class PinchInterpreter {
  constructor() {
    this.reset();
  }

  reset() {
    this.pinched = false;
    this.started = null;
    this.previousTap = null;
    this.filtered = null;
    this.lastTime = null;
    this.mustOpen = true;
  }

  sample(points, world, aspectY, time) {
    if (!points || points.length < 21) {
      this.reset();
      return null;
    }
    if (this.lastTime !== null && time - this.lastTime > 350) this.reset();

    const thumb = points[4],
      index = points[8];
    const span = (a, b) => Math.hypot(a.x - b.x, (a.y - b.y) * aspectY);
    const palmWidth = span(points[5], points[17]);
    if (palmWidth < 0.018) {
      this.reset();
      return null;
    }
    const distance3D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const separation =
      world?.length === 21
        ? distance3D(world[4], world[8]) /
          Math.max(0.005, distance3D(world[5], world[17]))
        : span(thumb, index) / palmWidth;
    const x = (index.x + thumb.x) / 2,
      y = (index.y + thumb.y) / 2;
    const blend = this.filtered
      ? 1 - Math.exp(-(time - this.lastTime) / 35)
      : 1;
    this.filtered = {
      x: (this.filtered?.x ?? x) + blend * (x - (this.filtered?.x ?? x)),
      y: (this.filtered?.y ?? y) + blend * (y - (this.filtered?.y ?? y)),
    };
    this.lastTime = time;
    if (separation > 0.5) this.mustOpen = false;

    const down = !this.mustOpen && separation < (this.pinched ? 0.5 : 0.27);
    let phase = down ? "hold" : "hover";
    let doublePinch = false;
    if (down && !this.pinched) {
      phase = "start";
      const last = this.previousTap;
      doublePinch = Boolean(
        last && time - last.time <= 530 && span(last, { x, y }) < palmWidth,
      );
      this.started = { x, y, time, consumed: doublePinch, moved: false };
      this.previousTap = null;
    }
    if (this.started && span(this.started, { x, y }) > palmWidth * 0.7) {
      this.started.moved = true;
    }
    if (!down && this.pinched) {
      phase = "end";
      if (
        this.started &&
        !this.started.consumed &&
        !this.started.moved &&
        time - this.started.time < 340
      ) {
        this.previousTap = { x, y, time };
      }
      this.started = null;
    }
    this.pinched = down;
    return { ...this.filtered, palmWidth, pinched: down, phase, doublePinch };
  }
}

export async function createHandTracker() {
  if (typeof createImageBitmap !== "function" || typeof Worker !== "function") {
    throw new Error("This browser cannot run the camera gesture worker.");
  }
  const worker = new Worker(new URL("./hand-worker.js", import.meta.url));
  const gesture = new PinchInterpreter();
  let busy = false,
    closed = false,
    generation = 0,
    failure;
  let latest = null,
    fresh = false,
    receivedAt = -Infinity;
  let initialized, rejected;
  const ready = new Promise((resolve, reject) => {
    initialized = resolve;
    rejected = reject;
  });
  function failed(message) {
    if (closed) return;
    failure = new Error(message || "Camera gesture tracking stopped.");
    busy = false;
    worker.terminate();
    rejected(failure);
  }
  worker.onerror = (event) => failed(event.message);
  worker.onmessageerror = () =>
    failed("The browser could not transfer a hand-tracking frame.");
  worker.onmessage = ({ data }) => {
    if (closed) return;
    if (data.type === "ready") {
      initialized();
      return;
    }
    if (data.type === "error") {
      failed(data.message);
      return;
    }
    busy = false;
    if (data.generation !== generation) return;
    latest = gesture.sample(data.points, data.world, data.aspectY, data.time);
    fresh = true;
    receivedAt = performance.now();
  };
  const timeout = setTimeout(
    () => failed("Camera gesture tracking took too long to start."),
    60000,
  );
  try {
    worker.postMessage({ type: "init" });
    await ready;
  } finally {
    clearTimeout(timeout);
  }

  // No queue: an inference always gets the newest camera frame available.
  async function submit(image, time, width, height, stamp) {
    busy = true;
    try {
      const scale = Math.min(1, 400 / Math.max(width, height));
      const bitmap = await createImageBitmap(image, {
        resizeWidth: Math.max(1, Math.round(width * scale)),
        resizeHeight: Math.max(1, Math.round(height * scale)),
        resizeQuality: "low",
      });
      if (closed || stamp !== generation) {
        bitmap.close();
        busy = false;
        return;
      }
      try {
        worker.postMessage({ type: "frame", bitmap, time, generation: stamp }, [
          bitmap,
        ]);
      } catch (error) {
        bitmap.close();
        throw error;
      }
    } catch (error) {
      failed(error.message);
    }
  }

  return {
    detect(image, time = performance.now()) {
      if (closed) return null;
      if (failure) throw failure;
      const w = image.videoWidth || image.naturalWidth || image.width;
      const h = image.videoHeight || image.naturalHeight || image.height;
      if (w && h && !busy) void submit(image, time, w, h, generation);
      if (fresh) {
        fresh = false;
        return latest;
      }
      if (!latest || performance.now() - receivedAt > 350) return null;
      // Preserve the grab between frames. Discrete transitions are consumed once.
      return {
        ...latest,
        phase: latest.pinched ? "hold" : "hover",
        doublePinch: false,
      };
    },
    reset() {
      generation++;
      gesture.reset();
      latest = null;
      fresh = false;
    },
    close() {
      closed = true;
      worker.terminate();
      latest = null;
      gesture.reset();
    },
  };
}
