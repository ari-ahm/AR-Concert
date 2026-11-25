// Orthographic inspection view. Coordinates are shared with the audio and AR sessions.
export function createMap(canvas, read, select) {
  let yaw = -0.58,
    tilt = 0.46,
    zoom = 1,
    drag = null,
    targets = [],
    pending = false;
  const ctx = canvas.getContext("2d");
  function draw() {
    pending = false;
    const { sources, listener, planes, room, selected } = read();
    const w = canvas.clientWidth,
      h = canvas.clientHeight,
      scale = Math.min(devicePixelRatio, 2);
    if (!w || !h) return;
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const spread = Math.max(room.width, room.depth, 4);
    const unit =
      Math.min(w / (spread * 1.6), h / (room.height + spread * 0.64)) * zoom;
    const [cx, cy, cz] = room.center;
    const floor = cy - room.height / 2,
      ceil = floor + room.height;
    const x0 = cx - room.width / 2,
      x1 = cx + room.width / 2,
      z0 = cz - room.depth / 2,
      z1 = cz + room.depth / 2;
    function project([x, y, z]) {
      const a = x - cx,
        b = z - cz,
        depth = a * Math.sin(yaw) + b * Math.cos(yaw);
      return [
        w / 2 + unit * (a * Math.cos(yaw) - b * Math.sin(yaw)),
        h * 0.48 + unit * (depth * Math.sin(tilt) - (y - cy) * Math.cos(tilt)),
      ];
    }
    function path(vertices, stroke, fill, dashed = false) {
      ctx.beginPath();
      vertices.forEach((p, i) => {
        const [x, y] = project(p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      if (fill) {
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.strokeStyle = stroke;
      ctx.setLineDash(dashed ? [4, 5] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const corners = [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ];
    const level = (y) => corners.map(([x, z]) => [x, y, z]);
    path(level(floor), "#667567", "#56665642");
    for (let i = 1; i < 12; i++) {
      const x = x0 + ((x1 - x0) * i) / 12,
        z = z0 + ((z1 - z0) * i) / 12;
      path(
        [
          [x, floor, z0],
          [x, floor, z1],
        ],
        "#55645976",
      );
      path(
        [
          [x0, floor, z],
          [x1, floor, z],
        ],
        "#55645976",
      );
    }
    const top = level(ceil);
    path([...top, top[0]], "#84948a9a", null, true);
    for (const [x, z] of corners)
      path(
        [
          [x, floor, z],
          [x, ceil, z],
        ],
        "#99aaa082",
        null,
        true,
      );
    planes.forEach((p) => {
      if (p.vertices?.length >= 3) path(p.vertices, "#88c2a8", "#82c4a344");
    });
    targets = [];
    const depth = (p) =>
      (p[0] - cx) * Math.sin(yaw) + (p[2] - cz) * Math.cos(yaw);
    const objects = [
      ...sources.map((s) => ({ ...s, speaker: true })),
      { position: listener.position },
    ].sort((a, b) => depth(a.position) - depth(b.position));
    objects.forEach((obj) => {
      const p = obj.position,
        [x, y] = project(p),
        [bx, by] = project([p[0], floor, p[2]]),
        speaker = obj.speaker;
      const color = speaker ? "#ff925c" : "#a7eed3";
      ctx.save();
      ctx.strokeStyle = speaker ? "#d5875c66" : "#8abca566";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 3; i >= 1; i--) {
        ctx.beginPath();
        ctx.ellipse(
          bx,
          by,
          unit * (0.18 + i * 0.15),
          unit * (0.18 + i * 0.15) * Math.sin(tilt),
          0,
          0,
          2 * Math.PI,
        );
        ctx.strokeStyle = speaker
          ? "rgba(255,144,82," + (0.08 + (3 - i) * 0.1) + ")"
          : "rgba(156,229,197,.17)";
        ctx.stroke();
      }
      if (speaker) {
        ctx.strokeStyle = color;
        ctx.fillStyle = "#52382b";
        ctx.lineWidth = obj.id === selected ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(x - 8, y - 13, 16, 25, 3);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y + 3, 4.3, 0, 2 * Math.PI);
        ctx.moveTo(x + 1.7, y - 6);
        ctx.arc(x, y - 6, 1.7, 0, 2 * Math.PI);
        ctx.stroke();
        targets.push({ id: obj.id, x, y });
      } else {
        const dir = listener.forward,
          [ex, ey] = project(p.map((v, i) => v + dir[i]));
        const heading = Math.atan2(ey - y, ex - x);
        ctx.translate(x, y);
        ctx.rotate(heading);
        ctx.beginPath();
        ctx.moveTo(11, 0);
        ctx.lineTo(-6, -6);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-6, 6);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.rotate(-heading);
        ctx.translate(-x, -y);
      }
      const label = speaker ? obj.label : "You";
      ctx.font = "600 12px ui-monospace,monospace";
      const lw = ctx.measureText(label).width;
      ctx.fillStyle = "#202722e6";
      ctx.fillRect(x - lw / 2 - 4, y - 33, lw + 8, 17);
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.fillText(label, x, y - 21);
      ctx.restore();
    });
  }
  const refresh = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(draw);
    }
  };
  canvas.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY, yaw, tilt };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    yaw = drag.yaw + (e.clientX - drag.x) * 0.009;
    tilt = Math.max(
      0.18,
      Math.min(1.24, drag.tilt + (e.clientY - drag.y) * 0.006),
    );
    refresh();
  };
  canvas.onpointerup = (e) => {
    if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) {
      const box = canvas.getBoundingClientRect();
      const t = targets.findLast(
        (v) =>
          Math.hypot(v.x - e.clientX + box.left, v.y - e.clientY + box.top) <
          22,
      );
      if (t) select(t.id);
    }
    drag = null;
  };
  canvas.onpointercancel = () => (drag = null);
  const observer = new ResizeObserver(refresh);
  observer.observe(canvas);
  return {
    refresh,
    dispose() {
      observer.disconnect();
    },
    zoom(step) {
      zoom = Math.max(0.55, Math.min(2.8, zoom + step));
      refresh();
    },
    reset() {
      yaw = -0.58;
      tilt = 0.46;
      zoom = 1;
      refresh();
    },
  };
}
