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
  uniform sampler2D u_flowDirs;   // RGBA: river_entry, river_exit, lava_entry, lava_exit
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
  varying vec2 v_quadPos;
  varying float v_forestDensity;
  varying vec4 v_flowData;        // river_entry, river_exit, lava_entry, lava_exit (0-8)

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

    // ── Elevation normalization ──
    // Blend between linear (preserves variation) and smoothstep (gentle coast).
    // Low land: mostly smoothstep (gentle). Mid-high: more linear (visible incline).
    float renderElev = elev;
    if (elev > WATER_LEVEL) {
      float landT = (elev - WATER_LEVEL) / (1.0 - WATER_LEVEL);
      float smooth = landT * landT * (3.0 - 2.0 * landT);
      // Blend: 70% smoothstep at coast, transitions to 70% linear at high elevation
      float blendT = landT; // 0 at coast, 1 at peak
      float normalized = mix(smooth, landT, blendT * 0.6);
      renderElev = WATER_LEVEL + normalized * (1.0 - WATER_LEVEL) * 0.75;
    }

    float floorElev = max(0.0, u_minElev - 0.02);
    float waterIz = WATER_LEVEL * hScale;
    float surfaceIz = renderElev * hScale;
    bool isWater = elev < WATER_LEVEL;

    // Pillar height:
    // Water tiles: from water surface down to global floor
    // Land tiles: from terrain surface down to LOWEST ADJACENT NEIGHBOR's surface.
    //   At coastlines (any neighbor is water), the pillar still descends to water level.
    //   For interior land tiles, pillar = just the height step to the lowest neighbor.
    //   This prevents tall cliff walls between adjacent land tiles (mesa/pillar look).
    float minNeighborElev = min(min(eN, eS), min(eW, eE));
    float landFloorElev = !isWater ? max(WATER_LEVEL, minNeighborElev) : floorElev;
    float sideTopIz = isWater ? waterIz : surfaceIz;
    float floorIz = isWater ? (floorElev * hScale) : (landFloorElev * hScale);
    float pillarH = max(0.0, sideTopIz - floorIz);

    // Water tiles always render side faces to prevent jagged gaps at coastlines
    bool waterNeedsSides = true;

    vec2 pos;
    v_pillarT = 0.0;

    if (a_faceType < 0.5) {
      // Face 0: terrain/seafloor at actual elevation
      float localX = (a_quad.x - a_quad.y);
      float localY = (a_quad.x + a_quad.y - 1.0);
      pos.x = ix + localX * tileW * 0.5;
      pos.y = iy - surfaceIz + localY * tileH * 0.5;
    } else if (a_faceType < 1.5) {
      // Face 1: right side pillar
      if (isWater && !waterNeedsSides) {
        // Hide: collapse to zero-area triangle
        pos = vec2(0.0, 0.0);
      } else {
        float topY = iy - sideTopIz;
        pos.x = ix + (1.0 - a_quad.y) * tileW * 0.5;
        pos.y = topY + a_quad.y * tileH * 0.5 + a_quad.x * pillarH;
        v_pillarT = a_quad.x;
      }
    } else if (a_faceType < 2.5) {
      // Face 2: left side pillar
      if (isWater && !waterNeedsSides) {
        pos = vec2(0.0, 0.0);
      } else {
        float topY = iy - sideTopIz;
        pos.x = ix - (1.0 - a_quad.y) * tileW * 0.5;
        pos.y = topY + a_quad.y * tileH * 0.5 + a_quad.x * pillarH;
        v_pillarT = a_quad.x;
      }
    } else {
      // Face 3: water surface — flat at sea level
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

    // Forest density: count how many of the 4 direct neighbors are forest (biome 2)
    // BIOME_REED_BEDS = 2, encoded as 2/255 ≈ 0.0078 in texture
    float forestSelf = abs(v_biome - 2.0) < 0.5 ? 1.0 : 0.0;
    float fN = abs(texture2D(u_biomes, texCoord + vec2(0.0, -texel)).r * 255.0 - 2.0) < 0.5 ? 1.0 : 0.0;
    float fS = abs(texture2D(u_biomes, texCoord + vec2(0.0,  texel)).r * 255.0 - 2.0) < 0.5 ? 1.0 : 0.0;
    float fW = abs(texture2D(u_biomes, texCoord + vec2(-texel, 0.0)).r * 255.0 - 2.0) < 0.5 ? 1.0 : 0.0;
    float fE = abs(texture2D(u_biomes, texCoord + vec2( texel, 0.0)).r * 255.0 - 2.0) < 0.5 ? 1.0 : 0.0;
    v_forestDensity = (forestSelf + fN + fS + fW + fE) / 5.0;

    // Flow directions: sample per-tile RGBA texture
    vec4 flowRaw = texture2D(u_flowDirs, texCoord);
    v_flowData = flowRaw * 255.0; // decode to 0-8 direction codes

    // Depth: isometric position only — no elevation in z.
    // Back tiles (low rRow+rCol) get high z (far), front tiles get low z (near).
    // Elevation handled by y-position, not depth buffer.
    float depthT = (rRow + rCol) / (gs * 2.0);
    float z = 0.9 - depthT * 0.85;
    // Water surface slightly in front of same-tile seafloor
    if (a_faceType > 2.5) z -= 0.005;
    gl_Position = vec4(pos.x, -pos.y, z, 1.0);
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
  varying vec4 v_flowData;

  uniform vec3 u_biomeColors[5];
  uniform float u_popMode;
  uniform float u_time;

  // Convert direction code (1-8) to quad UV coordinate on the tile diamond edge
  // 1=NW(0,0) 2=N(0.5,0) 3=NE(1,0) 4=E(1,0.5) 5=SE(1,1) 6=S(0.5,1) 7=SW(0,1) 8=W(0,0.5)
  vec2 dirToUV(float d) {
    if (d < 1.5) return vec2(0.0, 0.0);
    if (d < 2.5) return vec2(0.5, 0.0);
    if (d < 3.5) return vec2(1.0, 0.0);
    if (d < 4.5) return vec2(1.0, 0.5);
    if (d < 5.5) return vec2(1.0, 1.0);
    if (d < 6.5) return vec2(0.5, 1.0);
    if (d < 7.5) return vec2(0.0, 1.0);
    return vec2(0.0, 0.5);
  }

  // Distance from point p to line segment a→b
  float distToSeg(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
    return length(p - (a + ab * t));
  }

  void main() {
    int biome = int(v_biome + 0.5);

    bool isWaterFrag = v_elev < 0.20;

    // ═══════════════════════════════════════════════════════════
    // WATER RENDERING
    //
    // Strategy: everything opaque — no alpha blending for water.
    // "Transparency" is faked by mixing seafloor color with water
    // color in the shader. Shallow water shows seafloor through
    // tinted water. Deep water is mostly solid ocean blue.
    //
    // Face 0 (seafloor): renders at actual depth, visible through
    //   shallow water. Tinted blue-green to look "underwater."
    // Face 1/2 (sides): below waterline portion tinted ocean blue,
    //   above waterline portion shows natural terrain.
    // Face 3 (water surface): flat at sea level, fakes transparency
    //   by reconstructing seafloor color and mixing with ocean tint.
    // ═══════════════════════════════════════════════════════════

    // ── Face 3: Water surface with fake transparency ──
    if (v_faceType > 2.5) {
      if (!isWaterFrag) discard;

      float depth = clamp((0.20 - v_elev) / 0.18, 0.0, 1.0);

      // Reconstruct seafloor appearance
      // (what face 0 looks like at this tile — sandy/rocky ocean floor)
      vec3 seafloor = vec3(0.15, 0.14, 0.12); // neutral sandy bottom
      seafloor += vec3(v_elev * 0.3, v_elev * 0.25, v_elev * 0.15);
      seafloor += (v_dither - 0.5) * 0.03; // per-tile variation

      // Ocean tint that increases with depth
      vec3 shallowTint = vec3(0.10, 0.30, 0.35);  // turquoise
      vec3 deepTint = vec3(0.02, 0.06, 0.15);      // dark blue

      // Blend: shallow shows mostly seafloor, deep shows mostly ocean
      // depth 0.0 (shore) = 20% ocean + 80% seafloor
      // depth 0.5 (mid)   = 60% ocean + 40% seafloor
      // depth 1.0 (deep)  = 90% ocean + 10% seafloor
      float oceanMix = 0.2 + depth * 0.7;
      vec3 oceanColor = mix(shallowTint, deepTint, depth);
      vec3 finalColor = mix(seafloor, oceanColor, oceanMix);

      gl_FragColor = vec4(finalColor, 1.0);
      return;
    }

    // ── Face 0: Seafloor terrain (visible through shallow water) ──
    // Rendered at actual depth. Tinted to look underwater.
    if (isWaterFrag && v_faceType < 0.5) {
      float depth = clamp((0.20 - v_elev) / 0.18, 0.0, 1.0);

      // Sandy seafloor base
      vec3 seafloor = vec3(0.16, 0.14, 0.11);
      seafloor += vec3(v_elev * 0.25, v_elev * 0.20, v_elev * 0.12);
      seafloor += (v_dither - 0.5) * 0.03;

      // Blue-green underwater tint, stronger at depth
      vec3 underwaterTint = vec3(0.04, 0.12, 0.20);
      seafloor = mix(seafloor, underwaterTint, depth * 0.6);

      // Dim with depth
      seafloor *= (0.5 + 0.5 * (1.0 - depth));

      gl_FragColor = vec4(seafloor, 1.0);
      return;
    }

    // ── Face 1/2: Side faces ──
    // For water tiles: ocean-tinted walls
    // For land tiles near water: blend below-waterline portion to ocean
    if (isWaterFrag && v_faceType > 0.5 && v_faceType < 2.5) {
      float depth = clamp((0.20 - v_elev) / 0.18, 0.0, 1.0);
      vec3 waterSide = vec3(0.04, 0.10, 0.20);
      waterSide += vec3(0.03, 0.05, 0.06) * (1.0 - depth);
      waterSide *= (1.0 - v_pillarT * 0.4);
      gl_FragColor = vec4(waterSide, 1.0);
      return;
    }

    // ── Terrain color ──
    // Smooth spatial noise for gradual color variation across contiguous areas.
    // Uses elevation at coarse scale as a natural coherent noise source.
    // v_dither is per-tile hash, v_elev and v_veg provide spatial coherence.

    // Smooth spatial variation from stable values (elevation + tile hash)
    // Does NOT use vegetation — veg changes each tick, colors should not
    float spatialVar = fract(sin(v_elev * 127.1 + v_dither * 311.7) * 43758.5);
    float smoothVar = spatialVar * 0.6 + v_elev * 0.4;

    vec3 color;

    if (biome == 2) {
      // ── Forest: rich green with smooth variation ──
      vec3 deepForest = vec3(0.10, 0.24, 0.06);      // shaded forest
      vec3 midForest = vec3(0.16, 0.34, 0.10);       // mid canopy
      vec3 lightForest = vec3(0.22, 0.42, 0.14);     // sunlit canopy
      float forestT = clamp(v_forestDensity * 0.5 + smoothVar * 0.5, 0.0, 1.0);
      color = mix(deepForest, mix(midForest, lightForest, forestT), forestT);
      color += vec3(0.02, 0.03, 0.01) * v_elev;

    } else if (biome == 3) {
      // ── Beach: light warm sand ──
      vec3 wetSand = vec3(0.60, 0.52, 0.38);
      vec3 drySand = vec3(0.78, 0.70, 0.52);
      float sandT = clamp(smoothVar + (1.0 - v_coastal) * 0.3, 0.0, 1.0);
      color = mix(wetSand, drySand, sandT);

    } else if (biome == 4) {
      // ── Rocky: gray/slate with subtle warm undertones ──
      vec3 darkSlate = vec3(0.18, 0.17, 0.16);
      vec3 midGray = vec3(0.28, 0.27, 0.25);
      vec3 lightSlate = vec3(0.38, 0.36, 0.33);
      float rockT = clamp(smoothVar * 0.6 + v_elev * 0.4, 0.0, 1.0);
      color = mix(darkSlate, mix(midGray, lightSlate, rockT), rockT);

    } else {
      // Underwater biomes — use theme colors
      vec3 bc;
      if (biome == 0) bc = u_biomeColors[0];
      else bc = u_biomeColors[1];
      color = bc / 255.0 + vec3(v_elev * 0.12, v_elev * 0.08, v_elev * 0.06);
    }

    // ── Within-tile texture + tree sprites (top faces only) ──
    if (v_faceType < 0.5) {
      float n1 = fract(sin(v_quadPos.x * 43.1 + v_quadPos.y * 17.3 + v_dither * 91.7) * 43758.5);
      float n2 = fract(sin(v_quadPos.x * 127.3 + v_quadPos.y * 311.1 + v_dither * 53.2) * 28461.9);
      float n3 = fract(sin((v_quadPos.x + v_quadPos.y) * 73.7 + v_dither * 197.3) * 15731.3);

      color += (n1 - 0.5) * 0.02;

      if (biome == 2) {
        // Forest: tree sprites — small dark circles scattered across the tile
        // Number of trees depends on forest density
        vec3 treeColor = vec3(0.04, 0.12, 0.03);      // dark canopy
        vec3 treeLightColor = vec3(0.08, 0.20, 0.06);  // lit canopy edge
        float numTrees = 3.0 + v_forestDensity * 4.0;  // 3-7 trees

        for (float ti = 0.0; ti < 7.0; ti += 1.0) {
          if (ti >= numTrees) break;
          // Deterministic tree position within tile from tile hash + index
          float tx = fract(sin(v_dither * 73.1 + ti * 127.3) * 43758.5);
          float ty = fract(sin(v_dither * 311.7 + ti * 91.1) * 28461.9);
          // Keep trees away from tile edges
          tx = 0.15 + tx * 0.7;
          ty = 0.15 + ty * 0.7;

          float dist = length(v_quadPos - vec2(tx, ty));
          float treeSize = 0.08 + fract(sin(ti * 53.2 + v_dither * 17.3) * 15731.3) * 0.06;

          if (dist < treeSize) {
            // Tree canopy: dark center, slightly lighter edge
            float t = dist / treeSize;
            vec3 tc = mix(treeColor, treeLightColor, t);
            color = mix(color, tc, 0.7);
          }
        }
      } else if (biome == 3) {
        // Beach: fine sand grain + sparse trees if near forest
        color += (n1 * 0.6 + n2 * 0.4 - 0.5) * 0.02;

        // 1-2 trees on beach tiles adjacent to forest
        if (v_forestDensity > 0.1) {
          for (float ti = 0.0; ti < 2.0; ti += 1.0) {
            float tx = fract(sin(v_dither * 43.7 + ti * 197.3) * 28461.9);
            float ty = fract(sin(v_dither * 127.1 + ti * 53.7) * 43758.5);
            tx = 0.2 + tx * 0.6;
            ty = 0.2 + ty * 0.6;
            // Only show if hash passes threshold (sparse)
            float show = fract(sin(v_dither * 311.1 + ti * 73.7) * 15731.3);
            if (show < v_forestDensity * 0.6) {
              float dist = length(v_quadPos - vec2(tx, ty));
              if (dist < 0.07) {
                vec3 palmColor = vec3(0.06, 0.15, 0.04);
                color = mix(color, palmColor, 0.5 * (1.0 - dist / 0.07));
              }
            }
          }
        }
      } else if (biome == 4) {
        // Rock: crack lines
        float crack = abs(n1 - n2);
        if (crack < 0.06) {
          color *= 0.7;
        }
      }
    }

    // ── Rivers and lava drawn on tile surface (top faces only) ──
    if (v_faceType < 0.5) {
      vec2 center = vec2(0.5, 0.5);
      float lineWidth = 0.08; // river/lava line thickness in UV space

      // River (channels 0,1)
      float rEntry = v_flowData.r;
      float rExit = v_flowData.g;
      if (rEntry > 0.5 || rExit > 0.5) {
        float rDist = 999.0;
        if (rEntry > 0.5) {
          rDist = min(rDist, distToSeg(v_quadPos, dirToUV(rEntry), center));
        }
        if (rExit > 0.5) {
          rDist = min(rDist, distToSeg(v_quadPos, center, dirToUV(rExit)));
        }
        if (rDist < lineWidth) {
          float t = 1.0 - rDist / lineWidth;
          vec3 riverColor = vec3(0.08, 0.22, 0.45);
          color = mix(color, riverColor, t * 0.85);
        }
      }

      // Lava (channels 2,3)
      float lEntry = v_flowData.b;
      float lExit = v_flowData.a;
      if (lEntry > 0.5 || lExit > 0.5) {
        float lDist = 999.0;
        if (lEntry > 0.5) {
          lDist = min(lDist, distToSeg(v_quadPos, dirToUV(lEntry), center));
        }
        if (lExit > 0.5) {
          lDist = min(lDist, distToSeg(v_quadPos, center, dirToUV(lExit)));
        }
        if (lDist < lineWidth) {
          float t = 1.0 - lDist / lineWidth;
          vec3 lavaColor = vec3(0.75, 0.12, 0.02);
          color = mix(color, lavaColor, t * 0.9);
        }
      }
    }

    // Face shading
    float shade = v_shade;

    // Side face gradient
    if (v_faceType > 0.5 && v_faceType < 2.5) {
      shade *= (1.0 - v_pillarT * 0.5);

      // Coastal land sides: use earth/cliff tones instead of washed-out sand
      if (v_coastal > 0.0 && !isWaterFrag) {
        vec3 cliffColor = vec3(0.12, 0.10, 0.07); // dark earthy brown
        vec3 oceanBlend = vec3(0.05, 0.10, 0.16);  // dark ocean
        // Below sea level portion blends to ocean, above stays cliff
        float belowWater = clamp((0.20 - v_elev) / 0.10, 0.0, 1.0);
        vec3 coastSide = mix(cliffColor, oceanBlend, belowWater * v_pillarT);
        color = mix(color, coastSide, 0.5 + v_coastal * 0.5);
      }
    }

    color *= shade;

    // Underwater seafloor tint
    if (isWaterFrag && v_faceType < 0.5) {
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

// Flow rendering is now done in the terrain fragment shader via per-tile
// direction data (flowDirs texture). No separate flow geometry needed.

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
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

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
      u_flowDirs: gl.getUniformLocation(this.program, 'u_flowDirs'),
      u_popMode: gl.getUniformLocation(this.program, 'u_popMode'),
    };

    this.elevTexture = gl.createTexture();
    this.biomeTexture = gl.createTexture();
    this.popTexture = gl.createTexture();
    this.vegTexture = gl.createTexture();
    this.flowDirTexture = gl.createTexture();
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

    // Init flow direction texture as blank (RGBA)
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.flowDirTexture);
    const flowBlank = new Uint8Array(gridSize * gridSize * 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gridSize, gridSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, flowBlank);
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

  updateData(elevations, biomeData, vegetationData, flowDirsData, populations, speciesColors) {
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

    // Flow direction texture (RGBA: river_entry, river_exit, lava_entry, lava_exit)
    if (flowDirsData) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.flowDirTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gs, gs, 0, gl.RGBA, gl.UNSIGNED_BYTE, flowDirsData);
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
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

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
    gl.bindTexture(gl.TEXTURE_2D, this.flowDirTexture);

    gl.uniform1i(this.locs.u_elevations, 0);
    gl.uniform1i(this.locs.u_biomes, 1);
    gl.uniform1i(this.locs.u_popTex, 2);
    gl.uniform1i(this.locs.u_vegetation, 3);
    gl.uniform1i(this.locs.u_flowDirs, 4);

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
