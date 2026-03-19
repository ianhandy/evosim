/**
 * Procedural creature portraits — field-guide style vector illustrations.
 * Each species has a distinct silhouette. Trait values modulate proportions.
 * All drawing is Canvas 2D with glow effects.
 *
 * Usage: drawPortrait(ctx, speciesIndex, traitValue, size)
 * traitValue is the species-specific trait (0–1).
 */

/**
 * Draw a creature portrait centered in the canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} species - 0=Velothrix, 1=Leviathan, 2=Crawler, 3=Crab, 4=Worm
 * @param {number} trait - species-specific trait value (0–1)
 * @param {number} size - canvas size in CSS pixels
 * @param {string} color - species primary color hex
 */
export function drawPortrait(ctx, species, trait, size, color) {
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const unit = s / 40; // base unit for proportional drawing

  ctx.clearRect(0, 0, s, s);
  ctx.save();

  // Glow setup
  ctx.shadowColor = color;
  ctx.shadowBlur = 3 * unit;

  switch (species) {
    case 0: _drawVelothrix(ctx, cx, cy, unit, trait, color); break;
    case 1: _drawLeviathan(ctx, cx, cy, unit, trait, color); break;
    case 2: _drawCrawler(ctx, cx, cy, unit, trait, color); break;
    case 3: _drawCrab(ctx, cx, cy, unit, trait, color); break;
    case 4: _drawWorm(ctx, cx, cy, unit, trait, color); break;
  }

  ctx.restore();
}

/**
 * Velothrix aurantis — marsh stalker
 * Elongated body, thin stilt legs, fan crest radiating from head.
 * Crest Brightness (trait) → number of crest rays + glow intensity.
 */
function _drawVelothrix(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = u * 0.8;
  ctx.lineCap = 'round';

  // Body — elongated teardrop
  const bodyY = cy + u * 2;
  ctx.beginPath();
  ctx.ellipse(cx, bodyY, u * 3, u * 6, 0, 0, Math.PI * 2);
  ctx.globalAlpha = 0.15;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  // Neck
  ctx.beginPath();
  ctx.moveTo(cx, bodyY - u * 5);
  ctx.quadraticCurveTo(cx + u * 2, bodyY - u * 8, cx + u * 1, bodyY - u * 11);
  ctx.stroke();

  // Head
  const headX = cx + u * 1;
  const headY = bodyY - u * 11;
  ctx.beginPath();
  ctx.arc(headX, headY, u * 1.5, 0, Math.PI * 2);
  ctx.globalAlpha = 0.3;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  // Crest — fan of rays from head top
  const numRays = 3 + Math.round(trait * 6); // 3–9 rays
  const crestGlow = 2 + trait * 8;
  ctx.shadowBlur = crestGlow * u;
  ctx.lineWidth = u * 0.5;
  const fanSpread = Math.PI * 0.5;
  const startAngle = -Math.PI / 2 - fanSpread / 2;
  for (let i = 0; i < numRays; i++) {
    const angle = startAngle + (i / (numRays - 1)) * fanSpread;
    const rayLen = u * (4 + trait * 3);
    ctx.globalAlpha = 0.5 + trait * 0.4;
    ctx.beginPath();
    ctx.moveTo(headX, headY - u * 1.5);
    ctx.lineTo(headX + Math.cos(angle) * rayLen, headY - u * 1.5 + Math.sin(angle) * rayLen);
    ctx.stroke();
  }
  ctx.shadowBlur = 3 * u;

  // Legs — two thin stilts
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = u * 0.6;
  // Left leg
  ctx.beginPath();
  ctx.moveTo(cx - u * 1.5, bodyY + u * 4);
  ctx.lineTo(cx - u * 3, bodyY + u * 12);
  ctx.lineTo(cx - u * 4, bodyY + u * 12.5);
  ctx.stroke();
  // Right leg
  ctx.beginPath();
  ctx.moveTo(cx + u * 1.5, bodyY + u * 4);
  ctx.lineTo(cx + u * 2, bodyY + u * 12);
  ctx.lineTo(cx + u * 1, bodyY + u * 12.5);
  ctx.stroke();

  // Eye
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(headX + u * 0.5, headY - u * 0.3, u * 0.4, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Kelp Leviathan — aquatic predator
 * Torpedo body, dorsal spines, forked tail, angular jaw.
 * Hunting Range (trait) → jaw width + fin length.
 */
function _drawLeviathan(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = u * 0.8;
  ctx.lineCap = 'round';

  // Body — thick torpedo
  const bodyLen = u * 14;
  ctx.beginPath();
  ctx.ellipse(cx, cy, bodyLen * 0.5, u * 4, 0, 0, Math.PI * 2);
  ctx.globalAlpha = 0.15;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  // Jaw — angular V
  const jawW = u * (2 + trait * 3); // wider with trait
  ctx.lineWidth = u * 1;
  ctx.beginPath();
  ctx.moveTo(cx + bodyLen * 0.5, cy - jawW * 0.5);
  ctx.lineTo(cx + bodyLen * 0.5 + u * 3, cy);
  ctx.lineTo(cx + bodyLen * 0.5, cy + jawW * 0.5);
  ctx.stroke();

  // Dorsal spines
  const spineCount = 3;
  ctx.lineWidth = u * 0.6;
  ctx.globalAlpha = 0.6;
  for (let i = 0; i < spineCount; i++) {
    const sx = cx - bodyLen * 0.2 + i * u * 3;
    const spineH = u * (2 + trait * 2);
    ctx.beginPath();
    ctx.moveTo(sx, cy - u * 3.5);
    ctx.lineTo(sx + u * 0.5, cy - u * 3.5 - spineH);
    ctx.stroke();
  }

  // Tail fork
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = u * 0.7;
  const tailX = cx - bodyLen * 0.5;
  ctx.beginPath();
  ctx.moveTo(tailX, cy);
  ctx.lineTo(tailX - u * 4, cy - u * 3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tailX, cy);
  ctx.lineTo(tailX - u * 4, cy + u * 3);
  ctx.stroke();

  // Pectoral fin
  const finLen = u * (2 + trait * 2);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(cx + u * 2, cy + u * 3);
  ctx.quadraticCurveTo(cx + u * 4, cy + u * 3 + finLen, cx + u * 1, cy + u * 3 + finLen * 0.8);
  ctx.stroke();

  // Eye
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(cx + bodyLen * 0.35, cy - u * 1, u * 0.5, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Reed Crawler — burrowing herbivore
 * Segmented caterpillar body, antennae, tiny leg stubs.
 * Burrowing Depth (trait) → segment count + body compression.
 */
function _drawCrawler(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = u * 0.7;
  ctx.lineCap = 'round';

  const segments = 3 + Math.round(trait * 4); // 3–7
  const segR = u * (2.5 - trait * 0.5); // flatter when deep
  const segSpacing = segR * 1.4;
  const startX = cx - (segments * segSpacing) / 2;

  // Segments
  for (let i = 0; i < segments; i++) {
    const sx = startX + i * segSpacing;
    const squash = 1 - trait * 0.3; // compressed vertically when deep
    ctx.beginPath();
    ctx.ellipse(sx, cy, segR, segR * squash, 0, 0, Math.PI * 2);
    ctx.globalAlpha = 0.1 + (i === 0 ? 0.1 : 0);
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.stroke();

    // Tiny legs
    if (i > 0 && i < segments - 1) {
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = u * 0.4;
      ctx.beginPath();
      ctx.moveTo(sx, cy + segR * squash);
      ctx.lineTo(sx - u * 0.5, cy + segR * squash + u * 1.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, cy + segR * squash);
      ctx.lineTo(sx + u * 0.5, cy + segR * squash + u * 1.5);
      ctx.stroke();
    }
  }

  // Antennae from head
  const headX = startX;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = u * 0.5;
  ctx.beginPath();
  ctx.moveTo(headX, cy - segR);
  ctx.quadraticCurveTo(headX - u * 3, cy - segR - u * 4, headX - u * 4, cy - segR - u * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(headX, cy - segR);
  ctx.quadraticCurveTo(headX - u * 1, cy - segR - u * 5, headX + u * 1, cy - segR - u * 3);
  ctx.stroke();

  // Eye
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(headX + u * 0.8, cy - u * 0.5, u * 0.35, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Tidal Crab — armored scavenger
 * Wide hexagonal body, asymmetric claws, jointed legs.
 * Shell Thickness (trait) → body width/roundness + outline thickness.
 */
function _drawCrab(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';

  // Body — rounded hexagon, wider with trait
  const bodyW = u * (5 + trait * 3);
  const bodyH = u * (4 + trait * 1);
  ctx.lineWidth = u * (0.6 + trait * 0.8); // thicker outline with shell

  ctx.beginPath();
  ctx.ellipse(cx, cy, bodyW, bodyH, 0, 0, Math.PI * 2);
  ctx.globalAlpha = 0.15;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  // Shell ridges
  ctx.globalAlpha = 0.2;
  ctx.lineWidth = u * 0.4;
  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, bodyW * (0.4 + i * 0.2), bodyH * (0.4 + i * 0.2), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Legs — 3 per side
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = u * 0.5;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 3; i++) {
      const angle = (side === -1 ? Math.PI * 0.7 : Math.PI * 0.3) - i * 0.25 * side;
      const legX = cx + Math.cos(angle) * bodyW;
      const legY = cy + Math.sin(angle) * bodyH;
      const endX = legX + side * u * 4;
      const endY = legY + u * 3;
      ctx.beginPath();
      ctx.moveTo(legX, legY);
      ctx.quadraticCurveTo(legX + side * u * 2, legY - u, endX, endY);
      ctx.stroke();
    }
  }

  // Claws — asymmetric
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = u * 0.6;
  // Big claw (right)
  ctx.beginPath();
  ctx.moveTo(cx + bodyW * 0.8, cy - bodyH * 0.3);
  ctx.lineTo(cx + bodyW + u * 3, cy - u * 3);
  ctx.lineTo(cx + bodyW + u * 4, cy - u * 1);
  ctx.lineTo(cx + bodyW + u * 3, cy - u * 2);
  ctx.stroke();
  // Small claw (left)
  ctx.beginPath();
  ctx.moveTo(cx - bodyW * 0.8, cy - bodyH * 0.3);
  ctx.lineTo(cx - bodyW - u * 2, cy - u * 2.5);
  ctx.lineTo(cx - bodyW - u * 2.5, cy - u * 1);
  ctx.stroke();

  // Eyes on stalks
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 0;
  ctx.lineWidth = u * 0.4;
  ctx.strokeStyle = color;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * u * 2, cy - bodyH);
    ctx.lineTo(cx + side * u * 2.5, cy - bodyH - u * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + side * u * 2.5, cy - bodyH - u * 2, u * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Bioluminescent Worm — detritivore
 * Sinusoidal wave body, glow spots along length.
 * Glow Intensity (trait) → spot count, glow radius, brightness.
 */
function _drawWorm(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = u * 1.2;

  // Body — sinusoidal wave
  const bodyLen = u * 22;
  const amplitude = u * 3;
  const startX = cx - bodyLen / 2;
  const waveFreq = 2.5;

  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  for (let t = 0; t <= 1; t += 0.02) {
    const x = startX + t * bodyLen;
    const y = cy + Math.sin(t * Math.PI * waveFreq) * amplitude;
    if (t === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Thicker body outline for worm tube feel
  ctx.lineWidth = u * 2;
  ctx.globalAlpha = 0.1;
  ctx.stroke();

  // Glow spots along body
  const spotCount = 3 + Math.round(trait * 5); // 3–8
  const glowR = u * (1 + trait * 2);
  ctx.shadowBlur = glowR * 2;
  ctx.shadowColor = color;

  for (let i = 0; i < spotCount; i++) {
    const t = (i + 0.5) / spotCount;
    const x = startX + t * bodyLen;
    const y = cy + Math.sin(t * Math.PI * waveFreq) * amplitude;

    // Radial glow
    const grd = ctx.createRadialGradient(x, y, 0, x, y, glowR);
    grd.addColorStop(0, hexToRgba(color, 0.3 + trait * 0.5));
    grd.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = grd;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Spot center
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.4 + trait * 0.4;
    ctx.beginPath();
    ctx.arc(x, y, u * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Head
  const headX = startX;
  const headY = cy;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(headX, headY, u * 1.5, 0, Math.PI * 2);
  ctx.fill();
}

// Local helper (duplicated from ui.js to avoid circular dependency)
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
