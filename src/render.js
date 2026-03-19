/**
 * WebGL isometric terrain renderer.
 *
 * Renders the terrain as instanced quads (top face + 2 side faces per tile)
 * with per-tile attributes from the SharedArrayBuffer.
 *
 * The renderer reads typed array views directly — no data transformation needed.
 * Camera state (tilt, zoom, pan) is passed as uniforms.
 */

// ── Shader sources ──

const VERT_SRC = `
  attribute vec2 a_quad;          // unit quad vertex (0-1 range)
  attribute float a_tileIdx;      // which tile (flattened r*gs+c)
  attribute float a_faceType;     // 0=top, 1=right side, 2=left side

  uniform float u_gridSize;
  uniform vec2 u_resolution;
  uniform float u_tilt;           // 0.2-0.8
  uniform float u_zoom;
  uniform vec2 u_pan;
  uniform float u_heightScale;

  uniform sampler2D u_elevations;  // elevation data as texture
  uniform sampler2D u_biomes;      // biome data as texture

  varying vec3 v_color;
  varying float v_shade;
  varying float v_biome;
  varying float v_elev;
  varying float v_faceType;

  void main() {
    float gs = u_gridSize;
    float row = floor(a_tileIdx / gs);
    float col = a_tileIdx - row * gs;

    // Sample elevation
    vec2 texCoord = vec2((col + 0.5) / gs, (row + 0.5) / gs);
    float elev = texture2D(u_elevations, texCoord).r;

    // Isometric projection
    float tileW = (2.0 / gs) * 0.85 * u_zoom;
    float tileH = tileW * u_tilt;
    float hScale = u_heightScale * u_zoom / u_resolution.y * 2.0;

    float ix = (col - row) * tileW * 0.5;
    float iy = (col + row) * tileH * 0.5;
    float iz = elev * hScale;

    // Deep baseline for pillars
    float deepBase = gs * tileH * 0.5 + hScale * 0.5;
    float pillarH = deepBase - (iy - iz + tileH * 0.5);
    pillarH = max(0.0, pillarH);

    vec2 pos;
    if (a_faceType < 0.5) {
      // Top face diamond
      float qx = a_quad.x;
      float qy = a_quad.y;
      // Map unit quad to diamond: 4 vertices
      // 0,0 → top  |  1,0 → right  |  1,1 → bottom  |  0,1 → left
      pos.x = ix + (qx - qy) * tileW * 0.5;
      pos.y = iy - iz + (qx + qy - 1.0) * tileH * 0.5;
    } else if (a_faceType < 1.5) {
      // Right side face (quad from right point down)
      float qx = a_quad.x; // 0=top edge, 1=bottom edge
      float qy = a_quad.y; // 0=right point, 1=bottom point
      float topY = iy - iz;
      pos.x = ix + (1.0 - qy) * tileW * 0.5;
      pos.y = topY + qy * tileH * 0.5 + qx * pillarH;
    } else {
      // Left side face
      float qx = a_quad.x;
      float qy = a_quad.y;
      float topY = iy - iz;
      pos.x = ix - (1.0 - qy) * tileW * 0.5;
      pos.y = topY + qy * tileH * 0.5 + qx * pillarH;
    }

    // Apply pan and center
    pos.x += u_pan.x / u_resolution.x * 2.0;
    pos.y += u_pan.y / u_resolution.y * 2.0;

    // Shading
    v_shade = a_faceType < 0.5 ? 1.0 : (a_faceType < 1.5 ? 0.45 : 0.3);
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

  // Biome colors (must match themes.js order)
  uniform vec3 u_biomeColors[5];

  void main() {
    int biome = int(v_biome + 0.5);
    vec3 bc;
    if (biome == 0) bc = u_biomeColors[0];
    else if (biome == 1) bc = u_biomeColors[1];
    else if (biome == 2) bc = u_biomeColors[2];
    else if (biome == 3) bc = u_biomeColors[3];
    else bc = u_biomeColors[4];

    // Elevation brightening
    vec3 color = bc / 255.0 + vec3(v_elev * 0.12, v_elev * 0.08, v_elev * 0.06);

    // Apply face shading
    color *= v_shade;

    // Water shimmer for aquatic biomes
    if (biome <= 1 && v_faceType < 0.5) {
      color += vec3(0.02, 0.04, 0.08) * (1.0 - v_elev);
    }

    gl_FragColor = vec4(color, 1.0);
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
    this.gridSize = 0;
    this.elevTexture = null;
    this.biomeTexture = null;
    this.vertexCount = 0;
    this._init();
  }

  _init() {
    const gl = this.gl;
    gl.clearColor(0.07, 0.03, 0, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Compile shaders
    const vs = this._compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) { this.fallback = true; return; }

    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Shader link error:', gl.getProgramInfoLog(this.program));
      this.fallback = true;
      return;
    }

    gl.useProgram(this.program);

    // Get locations
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
      u_elevations: gl.getUniformLocation(this.program, 'u_elevations'),
      u_biomes: gl.getUniformLocation(this.program, 'u_biomes'),
      u_biomeColors: gl.getUniformLocation(this.program, 'u_biomeColors'),
    };

    // Create data textures
    this.elevTexture = gl.createTexture();
    this.biomeTexture = gl.createTexture();
  }

  /**
   * Set up geometry for a given grid size. Called once at sim init.
   */
  setup(gridSize) {
    if (this.fallback) return;
    const gl = this.gl;
    this.gridSize = gridSize;
    const G2 = gridSize * gridSize;

    // Each tile has 3 faces (top, right, left), each face is 2 triangles (6 vertices)
    // Total: G2 * 3 * 6 vertices
    const numVerts = G2 * 3 * 6;
    const quadData = new Float32Array(numVerts * 2); // a_quad (x,y)
    const tileData = new Float32Array(numVerts);     // a_tileIdx
    const faceData = new Float32Array(numVerts);     // a_faceType

    let vi = 0;
    for (let idx = 0; idx < G2; idx++) {
      for (let face = 0; face < 3; face++) {
        // Two triangles per face (6 vertices)
        // Quad corners: (0,0), (1,0), (1,1), (0,0), (1,1), (0,1)
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

    // Upload buffers
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);

    this.tileBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileBuf);
    gl.bufferData(gl.ARRAY_BUFFER, tileData, gl.STATIC_DRAW);

    this.faceBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, faceData, gl.STATIC_DRAW);
  }

  /**
   * Update elevation and biome data textures from SharedArrayBuffer views.
   */
  updateData(elevations, biomeData) {
    if (this.fallback) return;
    const gl = this.gl;
    const gs = this.gridSize;

    // Elevation → R32F texture (or LUMINANCE fallback)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.elevTexture);
    // WebGL1: use LUMINANCE with Uint8 approximation
    const elevU8 = new Uint8Array(gs * gs);
    for (let i = 0; i < gs * gs; i++) {
      elevU8[i] = Math.min(255, Math.max(0, Math.round(elevations[i] * 255)));
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gs, gs, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, elevU8);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Biome → LUMINANCE texture
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.biomeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gs, gs, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, biomeData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * Render the map.
   */
  render(camera, biomeColors) {
    if (this.fallback || !this.vertexCount) return;
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;

    // Resize
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (this.canvas.width !== cw * dpr || this.canvas.height !== ch * dpr) {
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    // Uniforms
    gl.uniform1f(this.locs.u_gridSize, this.gridSize);
    gl.uniform2f(this.locs.u_resolution, cw, ch);
    gl.uniform1f(this.locs.u_tilt, camera.tilt);
    gl.uniform1f(this.locs.u_zoom, camera.zoom);
    gl.uniform2f(this.locs.u_pan, camera.panX, camera.panY);
    gl.uniform1f(this.locs.u_heightScale, 80);

    // Textures
    gl.uniform1i(this.locs.u_elevations, 0);
    gl.uniform1i(this.locs.u_biomes, 1);

    // Biome colors as vec3 array
    const colorFlat = new Float32Array(15);
    for (let i = 0; i < 5; i++) {
      colorFlat[i * 3] = biomeColors[i][0];
      colorFlat[i * 3 + 1] = biomeColors[i][1];
      colorFlat[i * 3 + 2] = biomeColors[i][2];
    }
    gl.uniform3fv(this.locs.u_biomeColors, colorFlat);

    // Attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.locs.a_quad);
    gl.vertexAttribPointer(this.locs.a_quad, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileBuf);
    gl.enableVertexAttribArray(this.locs.a_tileIdx);
    gl.vertexAttribPointer(this.locs.a_tileIdx, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuf);
    gl.enableVertexAttribArray(this.locs.a_faceType);
    gl.vertexAttribPointer(this.locs.a_faceType, 1, gl.FLOAT, false, 0, 0);

    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
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
