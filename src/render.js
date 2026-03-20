/**
 * WebGL isometric terrain renderer.
 *
 * Renders the terrain as instanced quads (top face + 2 side faces per tile)
 * with per-tile attributes from the SharedArrayBuffer.
 *
 * Features:
 * - Terrain tiles with biome colors, elevation shading, dithering
 * - River overlay (line segments projected into iso space)
 * - Population heatmap overlay (per-tile RGBA texture)
 * - Camera: pan, zoom, tilt, rotation (45° snaps)
 */

// ── Terrain shaders ──

const VERT_SRC = `
  attribute vec2 a_quad;
  attribute float a_tileIdx;
  attribute float a_faceType;     // 0=top, 1=right side, 2=left side

  uniform float u_gridSize;
  uniform vec2 u_resolution;
  uniform float u_tilt;
  uniform float u_zoom;
  uniform vec2 u_pan;
  uniform float u_heightScale;
  uniform float u_rotation;

  uniform sampler2D u_elevations;
  uniform sampler2D u_biomes;
  uniform sampler2D u_popTex;     // population overlay (RGBA)
  uniform float u_popMode;        // 0=off, 1=on

  varying float v_shade;
  varying float v_biome;
  varying float v_elev;
  varying float v_faceType;
  varying float v_dither;
  varying vec4 v_popColor;

  void main() {
    float gs = u_gridSize;
    float row = floor(a_tileIdx / gs);
    float col = a_tileIdx - row * gs;

    v_dither = fract(sin(row * 127.1 + col * 311.7) * 43758.5453);

    vec2 texCoord = vec2((col + 0.5) / gs, (row + 0.5) / gs);
    float elev = texture2D(u_elevations, texCoord).r;

    // Population overlay color (sampled here for the vertex, interpolated to frag)
    v_popColor = u_popMode > 0.5 ? texture2D(u_popTex, texCoord) : vec4(0.0);

    // Rotate around grid center
    float center = (gs - 1.0) * 0.5;
    float cr = row - center;
    float cc = col - center;
    float cosR = cos(u_rotation);
    float sinR = sin(u_rotation);
    float rRow = cr * cosR - cc * sinR;
    float rCol = cr * sinR + cc * cosR;

    // Isometric projection
    float tileW = (2.0 / gs) * 0.85 * u_zoom;
    float tileH = tileW * u_tilt;
    float hScale = u_heightScale * u_zoom / u_resolution.y * 2.0;

    float ix = (rCol - rRow) * tileW * 0.5;
    float iy = (rCol + rRow) * tileH * 0.5;
    float iz = elev * hScale;

    float maxExtent = gs * 0.7072;
    float deepBase = maxExtent * tileH * 0.5 + hScale * 0.5;
    float pillarH = max(0.0, deepBase - (iy - iz + tileH * 0.5));

    float rightShade = 0.45 - 0.15 * sin(u_rotation);
    float leftShade = 0.30 + 0.15 * sin(u_rotation);

    vec2 pos;
    if (a_faceType < 0.5) {
      float localX = (a_quad.x - a_quad.y);
      float localY = (a_quad.x + a_quad.y - 1.0);
      pos.x = ix + localX * tileW * 0.5;
      pos.y = iy - iz + localY * tileH * 0.5;
    } else if (a_faceType < 1.5) {
      float topY = iy - iz;
      pos.x = ix + (1.0 - a_quad.y) * tileW * 0.5;
      pos.y = topY + a_quad.y * tileH * 0.5 + a_quad.x * pillarH;
    } else {
      float topY = iy - iz;
      pos.x = ix - (1.0 - a_quad.y) * tileW * 0.5;
      pos.y = topY + a_quad.y * tileH * 0.5 + a_quad.x * pillarH;
    }

    pos.x += u_pan.x / u_resolution.x * 2.0;
    pos.y += u_pan.y / u_resolution.y * 2.0;

    v_shade = a_faceType < 0.5 ? 1.0 : (a_faceType < 1.5 ? rightShade : leftShade);
    v_elev = elev;
    v_biome = texture2D(u_biomes, texCoord).r * 255.0;
    v_faceType = a_faceType;

    gl_Position = vec4(pos.x, -pos.y, 0.0, 1.0);
  }
`;

const FRAG_SRC = `
  precision mediump float;

  varying float v_shade;
  varying float v_biome;
  varying float v_elev;
  varying float v_faceType;
  varying float v_dither;
  varying vec4 v_popColor;

  uniform vec3 u_biomeColors[5];
  uniform float u_popMode;

  void main() {
    int biome = int(v_biome + 0.5);
    vec3 bc;
    if (biome == 0) bc = u_biomeColors[0];
    else if (biome == 1) bc = u_biomeColors[1];
    else if (biome == 2) bc = u_biomeColors[2];
    else if (biome == 3) bc = u_biomeColors[3];
    else bc = u_biomeColors[4];

    vec3 color = bc / 255.0 + vec3(v_elev * 0.12, v_elev * 0.08, v_elev * 0.06);

    // Dither on land top faces
    if (biome > 1 && v_faceType < 0.5) {
      color += (v_dither - 0.5) * 0.08;
    }

    // Apply face shading
    color *= v_shade;

    // Water shimmer
    if (biome <= 1 && v_faceType < 0.5) {
      color += vec3(0.02, 0.04, 0.08) * (1.0 - v_elev);
    }

    // Population overlay — blend on top faces only
    if (u_popMode > 0.5 && v_faceType < 0.5 && v_popColor.a > 0.01) {
      color = mix(color, v_popColor.rgb, v_popColor.a * 0.6);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ── River shaders (line segments in iso space) ──

const RIVER_VERT_SRC = `
  attribute vec2 a_pos;           // grid position (row, col) as float
  attribute float a_width;

  uniform float u_gridSize;
  uniform vec2 u_resolution;
  uniform float u_tilt;
  uniform float u_zoom;
  uniform vec2 u_pan;
  uniform float u_heightScale;
  uniform float u_rotation;
  uniform sampler2D u_elevations;

  varying float v_alpha;

  void main() {
    float gs = u_gridSize;
    float row = a_pos.x;
    float col = a_pos.y;

    // Sample elevation at this river point
    vec2 texCoord = vec2((col + 0.5) / gs, (row + 0.5) / gs);
    float elev = texture2D(u_elevations, texCoord).r;

    // Rotate around grid center
    float center = (gs - 1.0) * 0.5;
    float cr = row - center;
    float cc = col - center;
    float cosR = cos(u_rotation);
    float sinR = sin(u_rotation);
    float rRow = cr * cosR - cc * sinR;
    float rCol = cr * sinR + cc * cosR;

    // Isometric projection
    float tileW = (2.0 / gs) * 0.85 * u_zoom;
    float tileH = tileW * u_tilt;
    float hScale = u_heightScale * u_zoom / u_resolution.y * 2.0;

    float ix = (rCol - rRow) * tileW * 0.5;
    float iy = (rCol + rRow) * tileH * 0.5;
    float iz = elev * hScale;

    vec2 pos;
    pos.x = ix + u_pan.x / u_resolution.x * 2.0;
    pos.y = -(iy - iz + u_pan.y / u_resolution.y * 2.0);

    gl_Position = vec4(pos, 0.0, 1.0);
    gl_PointSize = max(2.0, a_width * u_zoom * 3.0);
    v_alpha = 0.7;
  }
`;

const RIVER_FRAG_SRC = `
  precision mediump float;
  varying float v_alpha;
  void main() {
    gl_FragColor = vec4(0.08, 0.27, 0.55, v_alpha);
  }
`;

// ── WebGL renderer class ──

export class MapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!this.gl) {
      console.warn('WebGL not available, falling back to Canvas 2D');
      this.fallback = true;
      return;
    }
    this.fallback = false;
    this.program = null;
    this.riverProgram = null;
    this.gridSize = 0;
    this.elevTexture = null;
    this.biomeTexture = null;
    this.popTexture = null;
    this.vertexCount = 0;
    this.riverVertCount = 0;
    this.popMode = false;
    this._init();
  }

  _init() {
    const gl = this.gl;
    gl.clearColor(0.07, 0.03, 0, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // ── Terrain program ──
    const vs = this._compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) { this.fallback = true; return; }

    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Terrain shader link error:', gl.getProgramInfoLog(this.program));
      this.fallback = true;
      return;
    }

    gl.useProgram(this.program);
    this.locs = {
      a_quad: gl.getAttribLocation(this.program, 'a_quad'),
      a_tileIdx: gl.getAttribLocation(this.program, 'a_tileIdx'),
      a_faceType: gl.getAttribLocation(this.program, 'a_faceType'),
      u_gridSize: gl.getUniformLocation(this.program, 'u_gridSize'),
      u_resolution: gl.getUniformLocation(this.program, 'u_resolution'),
      u_tilt: gl.getUniformLocation(this.program, 'u_tilt'),
      u_zoom: gl.getUniformLocation(this.program, 'u_zoom'),
      u_pan: gl.getUniformLocation(this.program, 'u_pan'),
      u_heightScale: gl.getUniformLocation(this.program, 'u_heightScale'),
      u_rotation: gl.getUniformLocation(this.program, 'u_rotation'),
      u_elevations: gl.getUniformLocation(this.program, 'u_elevations'),
      u_biomes: gl.getUniformLocation(this.program, 'u_biomes'),
      u_biomeColors: gl.getUniformLocation(this.program, 'u_biomeColors'),
      u_popTex: gl.getUniformLocation(this.program, 'u_popTex'),
      u_popMode: gl.getUniformLocation(this.program, 'u_popMode'),
    };

    // ── River program ──
    const rvs = this._compileShader(gl.VERTEX_SHADER, RIVER_VERT_SRC);
    const rfs = this._compileShader(gl.FRAGMENT_SHADER, RIVER_FRAG_SRC);
    if (rvs && rfs) {
      this.riverProgram = gl.createProgram();
      gl.attachShader(this.riverProgram, rvs);
      gl.attachShader(this.riverProgram, rfs);
      gl.linkProgram(this.riverProgram);
      if (gl.getProgramParameter(this.riverProgram, gl.LINK_STATUS)) {
        this.riverLocs = {
          a_pos: gl.getAttribLocation(this.riverProgram, 'a_pos'),
          a_width: gl.getAttribLocation(this.riverProgram, 'a_width'),
          u_gridSize: gl.getUniformLocation(this.riverProgram, 'u_gridSize'),
          u_resolution: gl.getUniformLocation(this.riverProgram, 'u_resolution'),
          u_tilt: gl.getUniformLocation(this.riverProgram, 'u_tilt'),
          u_zoom: gl.getUniformLocation(this.riverProgram, 'u_zoom'),
          u_pan: gl.getUniformLocation(this.riverProgram, 'u_pan'),
          u_heightScale: gl.getUniformLocation(this.riverProgram, 'u_heightScale'),
          u_rotation: gl.getUniformLocation(this.riverProgram, 'u_rotation'),
          u_elevations: gl.getUniformLocation(this.riverProgram, 'u_elevations'),
        };
        this.riverPosBuf = gl.createBuffer();
        this.riverWidthBuf = gl.createBuffer();
      } else {
        console.warn('River shader link failed');
        this.riverProgram = null;
      }
    }

    // Create textures
    this.elevTexture = gl.createTexture();
    this.biomeTexture = gl.createTexture();
    this.popTexture = gl.createTexture();
  }

  setup(gridSize) {
    if (this.fallback) return;
    const gl = this.gl;
    this.gridSize = gridSize;
    const G2 = gridSize * gridSize;

    const numVerts = G2 * 3 * 6;
    const quadData = new Float32Array(numVerts * 2);
    const tileData = new Float32Array(numVerts);
    const faceData = new Float32Array(numVerts);

    let vi = 0;
    for (let idx = 0; idx < G2; idx++) {
      for (let face = 0; face < 3; face++) {
        const corners = [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]];
        for (const [qx, qy] of corners) {
          quadData[vi * 2] = qx;
          quadData[vi * 2 + 1] = qy;
          tileData[vi] = idx;
          faceData[vi] = face;
          vi++;
        }
      }
    }
    this.vertexCount = vi;

    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);

    this.tileBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileBuf);
    gl.bufferData(gl.ARRAY_BUFFER, tileData, gl.STATIC_DRAW);

    this.faceBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, faceData, gl.STATIC_DRAW);

    // Init population texture as blank
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.popTexture);
    const blank = new Uint8Array(gridSize * gridSize * 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gridSize, gridSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, blank);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  updateData(elevations, biomeData, populations, speciesColors) {
    if (this.fallback) return;
    const gl = this.gl;
    const gs = this.gridSize;

    // Elevation texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.elevTexture);
    const elevU8 = new Uint8Array(gs * gs);
    for (let i = 0; i < gs * gs; i++) {
      elevU8[i] = Math.min(255, Math.max(0, Math.round(elevations[i] * 255)));
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gs, gs, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, elevU8);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Biome texture
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.biomeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gs, gs, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, biomeData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Population overlay texture (RGBA — dominant species color + intensity as alpha)
    if (populations && speciesColors) {
      const popRGBA = new Uint8Array(gs * gs * 4);
      for (let i = 0; i < gs * gs; i++) {
        let maxPop = 0, maxS = -1;
        for (let s = 0; s < 5; s++) {
          const p = populations[i * 5 + s];
          if (p > maxPop) { maxPop = p; maxS = s; }
        }
        if (maxPop > 5 && maxS >= 0) {
          const sc = speciesColors[maxS];
          const intensity = Math.min(200, Math.round(maxPop / 200 * 200));
          popRGBA[i * 4]     = sc[0];
          popRGBA[i * 4 + 1] = sc[1];
          popRGBA[i * 4 + 2] = sc[2];
          popRGBA[i * 4 + 3] = intensity;
        }
        // else stays (0,0,0,0) — transparent
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.popTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gs, gs, 0, gl.RGBA, gl.UNSIGNED_BYTE, popRGBA);
    }
  }

  /**
   * Update river geometry from SharedArrayBuffer views.
   * riverPaths: Int16Array of [r,c,...,-1,-1,...] per river
   * riverMeta: Float32Array of [id,age,width,active] per river
   */
  updateRivers(riverPaths, riverMeta) {
    if (this.fallback || !this.riverProgram) return;
    const gl = this.gl;
    const maxRivers = riverMeta.length / 4;

    // Build line segment vertices from river paths
    const positions = []; // [row, col] pairs
    const widths = [];
    let rpIdx = 0;

    for (let ri = 0; ri < maxRivers; ri++) {
      const riverId = riverMeta[ri * 4];
      if (riverId < 0) break;
      const width = Math.max(1, riverMeta[ri * 4 + 2]);
      const active = riverMeta[ri * 4 + 3] > 0;

      // Collect this river's path
      const path = [];
      while (rpIdx < riverPaths.length / 2) {
        const pr = riverPaths[rpIdx * 2];
        const pc = riverPaths[rpIdx * 2 + 1];
        rpIdx++;
        if (pr < 0) break;
        path.push([pr, pc]);
      }

      if (!active && path.length < 2) continue;

      // Emit line segments: each pair of consecutive points = 2 vertices
      for (let i = 0; i < path.length - 1; i++) {
        positions.push(path[i][0], path[i][1]);
        widths.push(width);
        positions.push(path[i + 1][0], path[i + 1][1]);
        widths.push(width);
      }
    }

    this.riverVertCount = widths.length;
    if (this.riverVertCount === 0) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.riverPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.riverWidthBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(widths), gl.DYNAMIC_DRAW);
  }

  setPopMode(enabled) {
    this.popMode = enabled;
  }

  render(camera, biomeColors) {
    if (this.fallback || !this.vertexCount) return;
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;

    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (this.canvas.width !== cw * dpr || this.canvas.height !== ch * dpr) {
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // ── Draw terrain ──
    gl.useProgram(this.program);

    gl.uniform1f(this.locs.u_gridSize, this.gridSize);
    gl.uniform2f(this.locs.u_resolution, cw, ch);
    gl.uniform1f(this.locs.u_tilt, camera.tilt);
    gl.uniform1f(this.locs.u_zoom, camera.zoom);
    gl.uniform2f(this.locs.u_pan, camera.panX, camera.panY);
    gl.uniform1f(this.locs.u_heightScale, 80);
    gl.uniform1f(this.locs.u_rotation, camera.rotation || 0);
    gl.uniform1f(this.locs.u_popMode, this.popMode ? 1.0 : 0.0);

    gl.uniform1i(this.locs.u_elevations, 0);
    gl.uniform1i(this.locs.u_biomes, 1);
    gl.uniform1i(this.locs.u_popTex, 2);

    const colorFlat = new Float32Array(15);
    for (let i = 0; i < 5; i++) {
      colorFlat[i * 3] = biomeColors[i][0];
      colorFlat[i * 3 + 1] = biomeColors[i][1];
      colorFlat[i * 3 + 2] = biomeColors[i][2];
    }
    gl.uniform3fv(this.locs.u_biomeColors, colorFlat);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.locs.a_quad);
    gl.vertexAttribPointer(this.locs.a_quad, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileBuf);
    gl.enableVertexAttribArray(this.locs.a_tileIdx);
    gl.vertexAttribPointer(this.locs.a_tileIdx, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuf);
    gl.enableVertexAttribArray(this.locs.a_faceType);
    gl.vertexAttribPointer(this.locs.a_faceType, 1, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    // ── Draw rivers ──
    if (this.riverProgram && this.riverVertCount > 0) {
      gl.useProgram(this.riverProgram);

      gl.uniform1f(this.riverLocs.u_gridSize, this.gridSize);
      gl.uniform2f(this.riverLocs.u_resolution, cw, ch);
      gl.uniform1f(this.riverLocs.u_tilt, camera.tilt);
      gl.uniform1f(this.riverLocs.u_zoom, camera.zoom);
      gl.uniform2f(this.riverLocs.u_pan, camera.panX, camera.panY);
      gl.uniform1f(this.riverLocs.u_heightScale, 80);
      gl.uniform1f(this.riverLocs.u_rotation, camera.rotation || 0);
      gl.uniform1i(this.riverLocs.u_elevations, 0); // reuse elevation texture

      gl.bindBuffer(gl.ARRAY_BUFFER, this.riverPosBuf);
      gl.enableVertexAttribArray(this.riverLocs.a_pos);
      gl.vertexAttribPointer(this.riverLocs.a_pos, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.riverWidthBuf);
      gl.enableVertexAttribArray(this.riverLocs.a_width);
      gl.vertexAttribPointer(this.riverLocs.a_width, 1, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.LINES, 0, this.riverVertCount);

      // Disable river attribs so they don't interfere
      gl.disableVertexAttribArray(this.riverLocs.a_pos);
      gl.disableVertexAttribArray(this.riverLocs.a_width);
    }
  }

  _compileShader(type, src) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }
}
