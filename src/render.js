/**
 * WebGL isometric terrain renderer.
 *
 * Renders terrain as instanced quads with seafloor/water layering:
 * - Face 0: terrain top (land or seafloor)
 * - Face 1: right pillar (extends to global min elevation)
 * - Face 2: left pillar
 * - Face 3: water surface (translucent diamond at sea level, water tiles only)
 *
 * Features: depth gradient water, directional hillshade, dithering,
 * animated water, population overlay, rotation, rivers.
 */

// ── Terrain shaders ──

const VERT_SRC = `
  precision mediump float;
  attribute vec2 a_quad;
  attribute float a_tileIdx;
  attribute float a_faceType;     // 0=terrain top, 1=right side, 2=left side, 3=water surface

  uniform float u_gridSize;
  uniform vec2 u_resolution;
  uniform float u_tilt;
  uniform float u_zoom;
  uniform vec2 u_pan;
  uniform float u_heightScale;
  uniform float u_rotSteps;       // 0,1,2,3 = 0,90,180,270 degrees
  uniform float u_minElev;
  uniform float u_time;

  uniform sampler2D u_elevations;
  uniform sampler2D u_biomes;
  uniform sampler2D u_popTex;
  uniform sampler2D u_vegetation;
  uniform sampler2D u_tileFlags;
  uniform float u_popMode;

  varying float v_shade;
  varying float v_biome;
  varying float v_elev;
  varying float v_faceType;
  varying float v_dither;
  varying vec4 v_popColor;
  varying float v_pillarT;
  varying float v_veg;
  varying float v_coastal;
  varying vec2 v_quadPos;         // position within tile (0-1)
  varying float v_forestDensity;  // how forested the neighborhood is (0-1)
  varying float v_flags;          // tile flags (river=1, volcanic=2)
  varying vec2 v_flowDir;         // flow direction based on elevation gradient

  void main() {
    float gs = u_gridSize;
    float row = floor(a_tileIdx / gs);
    float col = a_tileIdx - row * gs;

    // ── 90° grid rotation by remapping tile position ──
    // Data stays the same (texCoord unchanged), position rotates
    float rRow = row, rCol = col;
    int rot = int(u_rotSteps);
    if (rot == 1)      { rRow = col;          rCol = gs - 1.0 - row; }
    else if (rot == 2) { rRow = gs - 1.0 - row; rCol = gs - 1.0 - col; }
    else if (rot == 3) { rRow = gs - 1.0 - col; rCol = row; }

    v_dither = fract(sin(row * 127.1 + col * 311.7) * 43758.5453);

    // texCoord reads original tile data (not rotated)
    vec2 texCoord = vec2((col + 0.5) / gs, (row + 0.5) / gs);
    float elev = texture2D(u_elevations, texCoord).r;

    v_popColor = u_popMode > 0.5 ? texture2D(u_popTex, texCoord) : vec4(0.0);

    float WATER_LEVEL = 0.20;

    // Sample vegetation
    float veg = texture2D(u_vegetation, texCoord).r;
    v_veg = veg;

    // Isometric projection using rotated position
    float tileW = (2.0 / gs) * 0.85 * u_zoom;
    float tileH = tileW * u_tilt;
    float hScale = u_heightScale * u_zoom / u_resolution.y * 2.0;

    float ix = (rCol - rRow) * tileW * 0.5;
    float iy = (rCol + rRow) * tileH * 0.5;

    // Neighbor elevations for hillshade + coastal detection
    float texel = 1.0 / gs;
    float eN = texture2D(u_elevations, texCoord + vec2(0.0, -texel)).r;
    float eS = texture2D(u_elevations, texCoord + vec2(0.0,  texel)).r;
    float eW = texture2D(u_elevations, texCoord + vec2(-texel, 0.0)).r;
    float eE = texture2D(u_elevations, texCoord + vec2( texel, 0.0)).r;

    // Coastal factor: how many neighbors are underwater
    float waterNeighbors = 0.0;
    if (eN < WATER_LEVEL) waterNeighbors += 1.0;
    if (eS < WATER_LEVEL) waterNeighbors += 1.0;
    if (eW < WATER_LEVEL) waterNeighbors += 1.0;
    if (eE < WATER_LEVEL) waterNeighbors += 1.0;
    v_coastal = waterNeighbors / 4.0; // 0=inland, 1=surrounded by water

    // Height easing: smooth transition at waterline
    // Beach tiles (0.20-0.28) ease up gradually with a quadratic curve
    // so they don't jump abruptly from the flat water surface
    float renderElev = elev;
    float BEACH_ZONE = 0.08; // width of easing zone above sea level
    if (elev > WATER_LEVEL && elev < WATER_LEVEL + BEACH_ZONE) {
      float t = (elev - WATER_LEVEL) / BEACH_ZONE;
      renderElev = WATER_LEVEL + t * t * BEACH_ZONE; // quadratic ease-in
    }

    // Pillar from surface to global minimum
    float floorElev = max(0.0, u_minElev - 0.02);
    float surfaceIz = renderElev * hScale;
    float floorIz = floorElev * hScale;
    float pillarH = max(0.0, surfaceIz - floorIz);

    float waterIz = WATER_LEVEL * hScale;

    vec2 pos;
    v_pillarT = 0.0;

    if (a_faceType < 0.5) {
      // Face 0: flat terrain top diamond
      float localX = (a_quad.x - a_quad.y);
      float localY = (a_quad.x + a_quad.y - 1.0);
      pos.x = ix + localX * tileW * 0.5;
      pos.y = iy - surfaceIz + localY * tileH * 0.5;
    } else if (a_faceType < 1.5) {
      // Face 1: right side pillar
      float topY = iy - surfaceIz;
      pos.x = ix + (1.0 - a_quad.y) * tileW * 0.5;
      pos.y = topY + a_quad.y * tileH * 0.5 + a_quad.x * pillarH;
      v_pillarT = a_quad.x;
    } else if (a_faceType < 2.5) {
      // Face 2: left side pillar
      float topY = iy - surfaceIz;
      pos.x = ix - (1.0 - a_quad.y) * tileW * 0.5;
      pos.y = topY + a_quad.y * tileH * 0.5 + a_quad.x * pillarH;
      v_pillarT = a_quad.x;
    } else {
      // Face 3: water surface
      // Water surface: flat at sea level (wave animation moved to fragment shader)
      float localX = (a_quad.x - a_quad.y);
      float localY = (a_quad.x + a_quad.y - 1.0);
      pos.x = ix + localX * tileW * 0.5;
      pos.y = iy - waterIz + localY * tileH * 0.5;
    }

    // ── BACKUP: Sloped tiles (uncomment to enable) ──
    // To re-enable smooth slopes, replace the flat top face block above with:
    //   float eS = texture2D(u_elevations, texCoord + vec2(0.0, texel)).r;
    //   float eE = texture2D(u_elevations, texCoord + vec2(texel, 0.0)).r;
    //   float maxDev = 0.08;
    //   float eTop = mix(elev, clamp((eN+eW)*0.5, elev-maxDev, elev+maxDev), 0.4);
    //   float eRight = mix(elev, clamp((eN+eE)*0.5, elev-maxDev, elev+maxDev), 0.4);
    //   float eBottom = mix(elev, clamp((eS+eE)*0.5, elev-maxDev, elev+maxDev), 0.4);
    //   float eLeft = mix(elev, clamp((eS+eW)*0.5, elev-maxDev, elev+maxDev), 0.4);
    //   float cornerElev = mix(mix(eTop,eRight,a_quad.x), mix(eLeft,eBottom,a_quad.x), a_quad.y);
    //   pos.y = iy - cornerElev*hScale + localY*tileH*0.5;  (in face 0)
    //   And use per-corner elevations for side face top edges.

    // Pan
    pos.x += u_pan.x / u_resolution.x * 2.0;
    pos.y += u_pan.y / u_resolution.y * 2.0;

    // Hillshade for top faces
    if (a_faceType < 0.5) {
      v_shade = 0.5 + 0.5 * clamp(0.5 + (elev - eW) * 2.5 + (elev - eN) * 2.0, 0.0, 1.0);
    } else if (a_faceType < 2.5) {
      v_shade = a_faceType < 1.5 ? 0.45 : 0.3;
    } else {
      v_shade = 1.0;
    }

    v_elev = elev;
    v_biome = texture2D(u_biomes, texCoord).r * 255.0;
    v_faceType = a_faceType;
    v_quadPos = a_quad;

    // Tile flags: river (bit 0), volcanic (bit 1)
    v_flags = texture2D(u_tileFlags, texCoord).r * 255.0;

    // Flow direction: downhill gradient from neighbor elevations
    // Used for animating river/lava flow across the tile surface
    float eE_flow = texture2D(u_elevations, texCoord + vec2(texel, 0.0)).r;
    float eS_flow = texture2D(u_elevations, texCoord + vec2(0.0, texel)).r;
    v_flowDir = normalize(vec2(elev - eE_flow, elev - eS_flow) + 0.001);

    // Forest density: count how many of the 4 direct neighbors are forest (biome 2)
    // BIOME_REED_BEDS = 2, encoded as 2/255 ≈ 0.0078 in texture
    float forestSelf = abs(v_biome - 2.0) < 0.5 ? 1.0 : 0.0;
    float fN = abs(texture2D(u_biomes, texCoord + vec2(0.0, -texel)).r * 255.0 - 2.0) < 0.5 ? 1.0 : 0.0;
    float fS = abs(texture2D(u_biomes, texCoord + vec2(0.0,  texel)).r * 255.0 - 2.0) < 0.5 ? 1.0 : 0.0;
    float fW = abs(texture2D(u_biomes, texCoord + vec2(-texel, 0.0)).r * 255.0 - 2.0) < 0.5 ? 1.0 : 0.0;
    float fE = abs(texture2D(u_biomes, texCoord + vec2( texel, 0.0)).r * 255.0 - 2.0) < 0.5 ? 1.0 : 0.0;
    v_forestDensity = (forestSelf + fN + fS + fW + fE) / 5.0;

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
  varying float v_pillarT;
  varying float v_veg;
  varying float v_coastal;
  varying vec2 v_quadPos;
  varying float v_forestDensity;
  varying float v_flags;
  varying vec2 v_flowDir;

  uniform vec3 u_biomeColors[5];
  uniform float u_popMode;
  uniform float u_time;

  void main() {
    int biome = int(v_biome + 0.5);

    // ── Water surface (face type 3) ──
    if (v_faceType > 2.5) {
      if (biome > 1) discard;

      float depth = clamp((0.20 - v_elev) / 0.18, 0.0, 1.0);
      float caustic = 0.5 + 0.5 * sin(v_dither * 40.0 + u_time * 2.0);
      caustic = mix(1.0, caustic, 0.08 * (1.0 - depth));

      vec3 waterColor = vec3(
        (15.0 + (1.0 - depth) * 65.0) / 255.0,
        (70.0 + (1.0 - depth) * 90.0) / 255.0,
        (130.0 + (1.0 - depth) * 70.0) / 255.0
      ) * caustic;

      float alpha = 0.5 + depth * 0.4;
      gl_FragColor = vec4(waterColor, alpha);
      return;
    }

    // ── Dynamic terrain color ──
    // Base: biome color from theme
    vec3 bc;
    if (biome == 0) bc = u_biomeColors[0];
    else if (biome == 1) bc = u_biomeColors[1];
    else if (biome == 2) bc = u_biomeColors[2];
    else if (biome == 3) bc = u_biomeColors[3];
    else bc = u_biomeColors[4];
    vec3 color = bc / 255.0;

    // ── Contextual color modifiers (land tiles only) ──
    if (biome > 1) {
      // Coastal influence: tiles near water get sandy/lighter
      vec3 sandTint = u_biomeColors[2] / 255.0; // tidal flats color = sand
      color = mix(color, sandTint, v_coastal * 0.4);

      // Vegetation influence: lush = greener, barren = browner/rockier
      vec3 lushTint = vec3(0.12, 0.22, 0.08);    // deep green
      vec3 barrenTint = vec3(0.18, 0.13, 0.08);   // dry brown
      if (v_veg > 0.6) {
        color = mix(color, lushTint, (v_veg - 0.6) * 0.5);
      } else if (v_veg < 0.3) {
        color = mix(color, barrenTint, (0.3 - v_veg) * 0.4);
      }

      // Elevation brightening for high terrain
      color += vec3(v_elev * 0.08, v_elev * 0.05, v_elev * 0.03);
    } else {
      // Underwater: elevation-based depth coloring
      color += vec3(v_elev * 0.12, v_elev * 0.08, v_elev * 0.06);
    }

    // ── Within-tile texture (top faces only) ──
    if (v_faceType < 0.5) {
      // Multi-frequency noise from quad position + tile hash
      float n1 = fract(sin(v_quadPos.x * 43.1 + v_quadPos.y * 17.3 + v_dither * 91.7) * 43758.5);
      float n2 = fract(sin(v_quadPos.x * 127.3 + v_quadPos.y * 311.1 + v_dither * 53.2) * 28461.9);
      float n3 = fract(sin((v_quadPos.x + v_quadPos.y) * 73.7 + v_dither * 197.3) * 15731.3);

      // Base brightness variation
      color += (n1 - 0.5) * 0.04;

      if (biome == 2) {
        // Forest tiles: grass spots that increase with forest density
        // More contiguous forest = denser, greener grass
        float grassNoise = n2 * n3; // clustered spots
        float grassStrength = v_forestDensity * v_veg; // denser forest + more veg = more grass
        vec3 grassColor = vec3(0.08, 0.18, 0.04); // dark grass green
        vec3 lightGrass = vec3(0.15, 0.28, 0.08); // lighter grass patches
        // Sparse grass spots at low density, thick coverage at high density
        float grassThreshold = 0.8 - grassStrength * 0.6; // 0.8 at edges → 0.2 deep forest
        if (grassNoise > grassThreshold) {
          float t = (grassNoise - grassThreshold) / (1.0 - grassThreshold);
          vec3 gColor = mix(grassColor, lightGrass, n1);
          color = mix(color, gColor, t * 0.5 * grassStrength);
        }
      } else if (biome == 3) {
        // Beach tiles: sandy grain texture
        float grain = n1 * 0.7 + n2 * 0.3;
        color += (grain - 0.5) * 0.04;
        // Occasional darker wet sand patches near water
        if (v_coastal > 0.3 && n3 > 0.7) {
          color *= 0.92; // darker wet spot
        }
      } else if (biome == 4) {
        // Rocky/volcanic tiles: cracked dark rock texture
        vec3 darkRock = vec3(0.08, 0.06, 0.05);
        vec3 lightRock = vec3(0.16, 0.12, 0.10);
        // Craggy pattern from noise
        float rockPattern = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
        color = mix(darkRock, lightRock, rockPattern);
        // Cracks: dark lines where noise transitions sharply
        float crack = abs(n1 - n2);
        if (crack < 0.08) {
          color *= 0.6; // dark crack
        }
        // Volcanic glow: subtle orange in cracks for volcanic tiles
        float flagsHere = v_flags;
        if (flagsHere > 1.5 && crack < 0.12) {
          float glow = (0.12 - crack) / 0.12;
          color += vec3(0.3, 0.08, 0.0) * glow * (0.5 + 0.5 * sin(u_time * 2.0 + v_dither * 10.0));
        }
      }
    }

    // ── River and lava flow (top faces only) ──
    if (v_faceType < 0.5) {
      float flags = v_flags;
      bool hasRiver = flags > 0.5 && flags < 1.5 || flags > 2.5;  // bit 0
      bool hasVolcanic = flags > 1.5;                                // bit 1

      if (hasRiver) {
        // River: animated water flow across the tile
        // Flow follows elevation gradient (v_flowDir)
        float flowPhase = dot(v_quadPos, v_flowDir) * 3.0 - u_time * 1.2;
        float flow = 0.5 + 0.5 * sin(flowPhase * 6.28);
        float ripple = 0.5 + 0.5 * sin(flowPhase * 12.56 + v_dither * 20.0);

        vec3 riverDeep = vec3(0.06, 0.18, 0.38);
        vec3 riverLight = vec3(0.12, 0.30, 0.50);
        vec3 riverColor = mix(riverDeep, riverLight, flow * 0.6 + ripple * 0.2);

        // River covers most of the tile, fading at edges
        float centerDist = length(v_quadPos - 0.5) * 2.0;
        float riverMask = smoothstep(1.0, 0.3, centerDist);
        color = mix(color, riverColor, riverMask * 0.85);
      }

      if (hasVolcanic) {
        // Lava: glowing flow following same downhill gradient
        float lavaPhase = dot(v_quadPos, v_flowDir) * 2.0 - u_time * 0.4;
        float lavaFlow = 0.5 + 0.5 * sin(lavaPhase * 6.28);
        float lavaFlicker = 0.5 + 0.5 * sin(lavaPhase * 12.56 + v_dither * 15.0 + u_time * 3.0);

        vec3 lavaDark = vec3(0.25, 0.02, 0.0);    // cooled crust
        vec3 lavaHot = vec3(0.95, 0.35, 0.05);     // molten orange
        vec3 lavaGlow = vec3(1.0, 0.85, 0.2);      // bright yellow veins

        // Lava channels: hot veins through dark crust
        vec3 lavaColor = mix(lavaDark, lavaHot, lavaFlow * 0.7);
        // Bright veins in the flow channels
        if (lavaFlicker > 0.7) {
          lavaColor = mix(lavaColor, lavaGlow, (lavaFlicker - 0.7) * 2.0);
        }

        // Volcanic tile fully covered
        float centerDist = length(v_quadPos - 0.5) * 2.0;
        float lavaMask = smoothstep(1.0, 0.2, centerDist);
        color = mix(color, lavaColor, lavaMask * 0.9);
      }
    }

    // Face shading
    float shade = v_shade;

    // Side face gradient
    if (v_faceType > 0.5 && v_faceType < 2.5) {
      shade *= (1.0 - v_pillarT * 0.5);
    }

    color *= shade;

    // Underwater seafloor tint
    if (biome <= 1 && v_faceType < 0.5) {
      float depth = clamp((0.20 - v_elev) / 0.18, 0.0, 1.0);
      color *= (0.4 + 0.6 * (1.0 - depth));
      color += vec3(0.0, 0.02, 0.06) * depth;
    }

    // Population overlay
    if (u_popMode > 0.5 && v_faceType < 0.5 && v_popColor.a > 0.01) {
      color = mix(color, v_popColor.rgb, v_popColor.a * 0.6);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ── River shaders ──

const RIVER_VERT_SRC = `
  precision mediump float;
  attribute vec2 a_pos;
  attribute float a_width;

  uniform float u_gridSize;
  uniform vec2 u_resolution;
  uniform float u_tilt;
  uniform float u_zoom;
  uniform vec2 u_pan;
  uniform float u_heightScale;
  uniform float u_rotSteps;
  uniform sampler2D u_elevations;

  varying float v_alpha;

  void main() {
    float gs = u_gridSize;
    float row = a_pos.x;
    float col = a_pos.y;

    // Grid rotation
    float rRow = row, rCol = col;
    int rot = int(u_rotSteps);
    if (rot == 1)      { rRow = col;          rCol = gs - 1.0 - row; }
    else if (rot == 2) { rRow = gs - 1.0 - row; rCol = gs - 1.0 - col; }
    else if (rot == 3) { rRow = gs - 1.0 - col; rCol = row; }

    vec2 texCoord = vec2((col + 0.5) / gs, (row + 0.5) / gs);
    float elev = texture2D(u_elevations, texCoord).r;

    float tileW = (2.0 / gs) * 0.85 * u_zoom;
    float tileH = tileW * u_tilt;
    float hScale = u_heightScale * u_zoom / u_resolution.y * 2.0;

    float ix = (rCol - rRow) * tileW * 0.5;
    float iy = (rCol + rRow) * tileH * 0.5;
    float iz = elev * hScale;

    vec2 pos = vec2(ix, iy - iz);
    pos.x += u_pan.x / u_resolution.x * 2.0;
    pos.y += u_pan.y / u_resolution.y * 2.0;

    gl_Position = vec4(pos.x, -pos.y, 0.0, 1.0);
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
    this.minElev = 0;
    this.startTime = performance.now();
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
      u_rotSteps: gl.getUniformLocation(this.program, 'u_rotSteps'),
      u_minElev: gl.getUniformLocation(this.program, 'u_minElev'),
      u_time: gl.getUniformLocation(this.program, 'u_time'),
      u_elevations: gl.getUniformLocation(this.program, 'u_elevations'),
      u_biomes: gl.getUniformLocation(this.program, 'u_biomes'),
      u_biomeColors: gl.getUniformLocation(this.program, 'u_biomeColors'),
      u_popTex: gl.getUniformLocation(this.program, 'u_popTex'),
      u_vegetation: gl.getUniformLocation(this.program, 'u_vegetation'),
      u_tileFlags: gl.getUniformLocation(this.program, 'u_tileFlags'),
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
          u_rotSteps: gl.getUniformLocation(this.riverProgram, 'u_rotSteps'),
          u_elevations: gl.getUniformLocation(this.riverProgram, 'u_elevations'),
        };
        this.riverPosBuf = gl.createBuffer();
        this.riverWidthBuf = gl.createBuffer();
      } else {
        console.warn('River shader link failed');
        this.riverProgram = null;
      }
    }

    this.elevTexture = gl.createTexture();
    this.biomeTexture = gl.createTexture();
    this.popTexture = gl.createTexture();
    this.vegTexture = gl.createTexture();
    this.flagsTexture = gl.createTexture();
  }

  setup(gridSize) {
    if (this.fallback) return;
    const gl = this.gl;
    this.gridSize = gridSize;
    const G2 = gridSize * gridSize;

    // 4 faces per tile: terrain top(0), right side(1), left side(2), water surface(3)
    const FACES = 4;
    const numVerts = G2 * FACES * 6;
    const quadData = new Float32Array(numVerts * 2);
    const tileData = new Float32Array(numVerts);
    const faceData = new Float32Array(numVerts);

    let vi = 0;
    for (let idx = 0; idx < G2; idx++) {
      for (let face = 0; face < FACES; face++) {
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

    // Init tile flags texture as blank
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.flagsTexture);
    const flagsBlank = new Uint8Array(gridSize * gridSize);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gridSize, gridSize, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, flagsBlank);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Init vegetation texture as blank
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.vegTexture);
    const vegBlank = new Uint8Array(gridSize * gridSize);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gridSize, gridSize, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, vegBlank);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  updateData(elevations, biomeData, vegetationData, tileFlagsData, populations, speciesColors) {
    if (this.fallback) return;
    const gl = this.gl;
    const gs = this.gridSize;

    // Track global min elevation for pillar base
    let minE = 1;
    const elevU8 = new Uint8Array(gs * gs);
    for (let i = 0; i < gs * gs; i++) {
      const e = elevations[i];
      if (e < minE) minE = e;
      elevU8[i] = Math.min(255, Math.max(0, Math.round(e * 255)));
    }
    this.minElev = minE;

    // Elevation texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.elevTexture);
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

    // Vegetation texture
    if (vegetationData) {
      const vegU8 = new Uint8Array(gs * gs);
      for (let i = 0; i < gs * gs; i++) {
        vegU8[i] = Math.min(255, Math.max(0, Math.round(vegetationData[i] * 255)));
      }
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.vegTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gs, gs, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, vegU8);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // Tile flags texture
    if (tileFlagsData) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.flagsTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gs, gs, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, tileFlagsData);
    }

    // Population overlay texture
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
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.popTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gs, gs, 0, gl.RGBA, gl.UNSIGNED_BYTE, popRGBA);
    }
  }

  updateRivers(riverPaths, riverMeta) {
    if (this.fallback || !this.riverProgram) return;
    const gl = this.gl;
    const maxRivers = riverMeta.length / 4;

    const positions = [];
    const widths = [];
    let rpIdx = 0;

    for (let ri = 0; ri < maxRivers; ri++) {
      const riverId = riverMeta[ri * 4];
      if (riverId < 0) break;
      const width = Math.max(1, riverMeta[ri * 4 + 2]);

      const path = [];
      while (rpIdx < riverPaths.length / 2) {
        const pr = riverPaths[rpIdx * 2];
        const pc = riverPaths[rpIdx * 2 + 1];
        rpIdx++;
        if (pr < 0) break;
        path.push([pr, pc]);
      }

      if (path.length < 2) continue;

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

    const time = (performance.now() - this.startTime) / 1000;

    // ── Draw terrain ──
    gl.useProgram(this.program);

    gl.uniform1f(this.locs.u_gridSize, this.gridSize);
    gl.uniform2f(this.locs.u_resolution, cw, ch);
    gl.uniform1f(this.locs.u_tilt, camera.tilt);
    gl.uniform1f(this.locs.u_zoom, camera.zoom);
    gl.uniform2f(this.locs.u_pan, camera.panX, camera.panY);
    gl.uniform1f(this.locs.u_heightScale, 160);
    gl.uniform1f(this.locs.u_rotSteps, camera.rotSteps || 0);
    gl.uniform1f(this.locs.u_minElev, this.minElev);
    gl.uniform1f(this.locs.u_time, time);
    gl.uniform1f(this.locs.u_popMode, this.popMode ? 1.0 : 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.elevTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.biomeTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.popTexture);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.vegTexture);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.flagsTexture);

    gl.uniform1i(this.locs.u_elevations, 0);
    gl.uniform1i(this.locs.u_biomes, 1);
    gl.uniform1i(this.locs.u_popTex, 2);
    gl.uniform1i(this.locs.u_vegetation, 3);
    gl.uniform1i(this.locs.u_tileFlags, 4);

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

    gl.disableVertexAttribArray(this.locs.a_quad);
    gl.disableVertexAttribArray(this.locs.a_tileIdx);
    gl.disableVertexAttribArray(this.locs.a_faceType);

    // ── Draw rivers ──
    if (this.riverProgram && this.riverLocs && this.riverVertCount > 0) {
      gl.useProgram(this.riverProgram);

      gl.uniform1f(this.riverLocs.u_gridSize, this.gridSize);
      gl.uniform2f(this.riverLocs.u_resolution, cw, ch);
      gl.uniform1f(this.riverLocs.u_tilt, camera.tilt);
      gl.uniform1f(this.riverLocs.u_zoom, camera.zoom);
      gl.uniform2f(this.riverLocs.u_pan, camera.panX, camera.panY);
      gl.uniform1f(this.riverLocs.u_heightScale, 160);
      gl.uniform1f(this.riverLocs.u_rotSteps, camera.rotSteps || 0);
      gl.uniform1i(this.riverLocs.u_elevations, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.riverPosBuf);
      gl.enableVertexAttribArray(this.riverLocs.a_pos);
      gl.vertexAttribPointer(this.riverLocs.a_pos, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.riverWidthBuf);
      gl.enableVertexAttribArray(this.riverLocs.a_width);
      gl.vertexAttribPointer(this.riverLocs.a_width, 1, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.LINES, 0, this.riverVertCount);

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
