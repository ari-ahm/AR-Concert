// A hit-test-only runtime supplies samples, without extents. Promote a patch
// only after separate, non-collinear samples establish an observed footprint.
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a) => a.map((v) => v / Math.hypot(...a));
function hull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2) {
        const a = out[out.length - 2],
          b = out[out.length - 1];
        if (
          (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >
          0.0001
        )
          break;
        out.pop();
      }
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

export class SampledSurfaces {
  patches = [];
  update(hit) {
    if (
      !hit?.orientation ||
      ![...hit.point, ...hit.normal].every(Number.isFinite)
    )
      return;
    let patch = this.patches.find(
      (p) =>
        Math.abs(dot(p.normal, hit.normal)) > 0.985 &&
        Math.abs(dot(sub(hit.point, p.point), p.normal)) < 0.07 &&
        p.samples.some((s) => Math.hypot(...sub(s, hit.point)) < 1.35),
    );
    if (!patch) {
      if (this.patches.length >= 48) return;
      const axis = Math.abs(hit.normal[1]) > 0.8 ? [1, 0, 0] : [0, 1, 0];
      const u = unit(cross(axis, hit.normal));
      patch = {
        ...hit,
        u,
        v: cross(hit.normal, u),
        samples: [],
        vertices: [],
        source: "sampled",
        estimated: true,
      };
      this.patches.push(patch);
    }
    if (patch.samples.some((s) => Math.hypot(...sub(s, hit.point)) < 0.09))
      return;
    const d = sub(hit.point, patch.point);
    const uv = [dot(d, patch.u), dot(d, patch.v)];
    const planar = (u, v) =>
      patch.point.map((p, i) => p + u * patch.u[i] + v * patch.v[i]);
    const sample = planar(...uv);
    const history = [...patch.samples, sample];
    const outline = hull(
      history.map((p) => [
        dot(sub(p, patch.point), patch.u),
        dot(sub(p, patch.point), patch.v),
      ]),
    );
    patch.samples =
      history.length < 72 ? history : outline.map((p) => planar(...p));
    if (outline.length < 3) return;
    const area =
      Math.abs(
        outline.reduce((sum, p, i) => {
          const q = outline[(i + 1) % outline.length];
          return sum + p[0] * q[1] - q[0] * p[1];
        }, 0),
      ) / 2;
    if (area >= 0.045) patch.vertices = outline.map((p) => planar(...p));
  }
  get planes() {
    return this.patches
      .filter((p) => p.vertices.length >= 3)
      .map(({ point, normal, orientation, vertices, source, estimated }) => ({
        point,
        normal,
        orientation,
        vertices,
        source,
        estimated,
      }));
  }
}
