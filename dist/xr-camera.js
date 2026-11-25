// Sample the runtime-owned camera texture before the XRFrame expires. Read back
// only a model-sized image. The XR compositor continues to own the visible feed.
export function cameraSampler(gl, session) {
  const binding = new XRWebGLBinding(session, gl);
  const program = gl.createProgram();
  const sources = [
    [
      gl.VERTEX_SHADER,
      `#version 300 es
      out vec2 uv;
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        uv = vec2(p.x, 1.0 - p.y);
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`,
    ],
    [
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision mediump float;
      uniform sampler2D camera;
      in vec2 uv;
      out vec4 color;
      void main() { color = vec4(texture(camera, uv).rgb, 1.0); }`,
    ],
  ];
  for (const [type, source] of sources) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    throw new Error("Camera sampling is unavailable.");
  }
  const target = gl.createTexture();
  const buffer = gl.createFramebuffer();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  let image;
  return {
    sample(camera) {
      const texture = binding.getCameraImage(camera);
      if (!texture) return null;
      const scale = 384 / Math.max(camera.width, camera.height);
      const w = Math.max(1, Math.round(camera.width * scale));
      const h = Math.max(1, Math.round(camera.height * scale));
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      if (!image || w !== canvas.width || h !== canvas.height) {
        canvas.width = w;
        canvas.height = h;
        image = context.createImageData(w, h);
        gl.bindTexture(gl.TEXTURE_2D, target);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          w,
          h,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          target,
          0,
        );
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
        ) {
          throw new Error("Camera image readback is unavailable.");
        }
      }
      gl.viewport(0, 0, w, h);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(
        0,
        0,
        w,
        h,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(image.data.buffer),
      );
      context.putImageData(image, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return canvas;
    },
    close() {
      gl.deleteTexture(target);
      gl.deleteFramebuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
