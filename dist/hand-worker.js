// This is a classic worker because the pinned WASM loader uses importScripts.
let model,
  lastTime = -1;
async function initialize() {
  const { FilesetResolver, HandLandmarker } =
    await import("./vendor/mediapipe/vision_bundle.mjs");
  const asset = (name) =>
    new URL("./vendor/mediapipe/" + name, self.location.href).href;
  const files = await FilesetResolver.forVisionTasks(asset("wasm"));
  model = await HandLandmarker.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: asset("hand_landmarker.task"),
      delegate: "CPU",
    },
    canvas: new OffscreenCanvas(1, 1),
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.55,
  });
}

self.onmessage = async ({ data }) => {
  const { bitmap } = data;
  try {
    if (data.type === "init") {
      await initialize();
      self.postMessage({ type: "ready" });
      return;
    }
    lastTime = Math.max(lastTime + 0.01, data.time);
    const result = model.detectForVideo(bitmap, lastTime);
    self.postMessage({
      type: "sample",
      points: result.landmarks[0],
      world: result.worldLandmarks[0],
      time: data.time,
      aspectY: bitmap.height / bitmap.width,
      generation: data.generation,
    });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  } finally {
    bitmap?.close();
  }
};
