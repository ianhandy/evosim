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
 * Long-legged wading bird silhouette. Trait = Crest Brightness.
 * High trait: more crest rays, more vivid glow. Low trait: sparse, dimmer.
 * Improvements: S-curve neck, ankle joints on stilts, tapered teardrop body,
 * vestigial wing-stub at shoulder, tail extension below body.
 */
function _drawVelothrix(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Body — teardrop, wider at hip/belly, tapering to neck
  // Centered slightly below canvas center
  const bodyX = cx;
  const bodyY = cy + u * 3;
  const bodyW = u * 2.8;   // narrow width (bird-like)
  const bodyH = u * 5.5;   // tall body

  ctx.lineWidth = u * 0.8;
  ctx.beginPath();
  // Teardrop via bezier: wide at bottom, narrow at top
  ctx.moveTo(bodyX, bodyY - bodyH * 0.55);         // top (neck base)
  ctx.bezierCurveTo(
    bodyX + bodyW * 1.1, bodyY - bodyH * 0.55,     // ctrl: right shoulder
    bodyX + bodyW * 1.4, bodyY + bodyH * 0.45,     // ctrl: right hip
    bodyX, bodyY + bodyH * 0.55                    // bottom tail
  );
  ctx.bezierCurveTo(
    bodyX - bodyW * 1.4, bodyY + bodyH * 0.45,     // ctrl: left hip
    bodyX - bodyW * 1.1, bodyY - bodyH * 0.55,     // ctrl: left shoulder
    bodyX, bodyY - bodyH * 0.55                    // top again
  );
  ctx.globalAlpha = 0.12;
  ctx.fill();
  ctx.globalAlpha = 0.75;
  ctx.stroke();

  // Tail tip — small extension below body
  ctx.lineWidth = u * 0.6;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(bodyX, bodyY + bodyH * 0.55);
  ctx.quadraticCurveTo(bodyX - u * 0.8, bodyY + bodyH * 0.55 + u * 1.5,
                       bodyX - u * 1.2, bodyY + bodyH * 0.55 + u * 1.2);
  ctx.stroke();

  // Wing stub at shoulder (vestigial)
  ctx.lineWidth = u * 0.5;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(bodyX + bodyW * 0.9, bodyY - u * 1.5);
  ctx.quadraticCurveTo(bodyX + bodyW * 1.8, bodyY - u * 0.5,
                       bodyX + bodyW * 1.5, bodyY + u * 1.0);
  ctx.stroke();

  // Neck — S-curve: sweeps back then forward to head
  const neckBaseX = bodyX;
  const neckBaseY = bodyY - bodyH * 0.55;
  const headX = cx - u * 0.5 + trait * u * 2;    // head position shifts with crest
  const headY = neckBaseY - u * 10;

  ctx.lineWidth = u * 0.9;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(neckBaseX, neckBaseY);
  ctx.bezierCurveTo(
    neckBaseX + u * 2.5, neckBaseY - u * 3,      // ctrl1: lean right near body
    headX - u * 2,       headY + u * 3,           // ctrl2: lean back near head
    headX,               headY                    // head
  );
  ctx.stroke();

  // Head
  ctx.lineWidth = u * 0.8;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.ellipse(headX, headY, u * 1.5, u * 1.3, 0, 0, Math.PI * 2);
  ctx.globalAlpha = 0.25;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  // Beak — thin pointed bill
  ctx.lineWidth = u * 0.5;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(headX + u * 1.2, headY + u * 0.2);
  ctx.lineTo(headX + u * 3.5, headY + u * 0.8);
  ctx.stroke();

  // Crest — fan of rays from head top; count + glow scale with trait
  const numRays = 3 + Math.round(trait * 6); // 3–9 rays
  const crestGlow = 2 + trait * 8;
  ctx.shadowBlur = crestGlow * u;
  ctx.lineWidth = u * 0.45;
  const fanSpread = Math.PI * 0.55;
  const startAngle = -Math.PI / 2 - fanSpread / 2;
  for (let i = 0; i < numRays; i++) {
    const angle = startAngle + (i / (numRays - 1)) * fanSpread;
    const rayLen = u * (3.5 + trait * 3.5);
    const opacity = 0.45 + trait * 0.45;
    ctx.globalAlpha = opacity * (0.6 + 0.4 * (i === Math.floor(numRays / 2) ? 1 : 0));
    ctx.beginPath();
    ctx.moveTo(headX, headY - u * 1.2);
    ctx.lineTo(headX + Math.cos(angle) * rayLen, headY - u * 1.2 + Math.sin(angle) * rayLen);
    ctx.stroke();
  }
  ctx.shadowBlur = 3 * u;

  // Stilt legs with ankle joints
  ctx.lineWidth = u * 0.6;
  ctx.globalAlpha = 0.6;
  const hipY = bodyY + bodyH * 0.3;

  // Left leg: hip → knee → ankle → foot
  const lHipX = bodyX - u * 1.3;
  const lKneeX = bodyX - u * 2.2;
  const lKneeY = hipY + u * 4;
  const lAnkleX = bodyX - u * 1.6;
  const lAnkleY = lKneeY + u * 3;
  const lFootY = lAnkleY + u * 1.0;
  ctx.beginPath();
  ctx.moveTo(lHipX, hipY);
  ctx.lineTo(lKneeX, lKneeY);
  ctx.lineTo(lAnkleX, lAnkleY);
  ctx.lineTo(lAnkleX - u * 1.2, lFootY); // foot spread
  ctx.stroke();

  // Right leg
  const rHipX = bodyX + u * 1.3;
  const rKneeX = bodyX + u * 2.0;
  const rKneeY = hipY + u * 4;
  const rAnkleX = bodyX + u * 1.4;
  const rAnkleY = rKneeY + u * 3;
  const rFootY = rAnkleY + u * 1.0;
  ctx.beginPath();
  ctx.moveTo(rHipX, hipY);
  ctx.lineTo(rKneeX, rKneeY);
  ctx.lineTo(rAnkleX, rAnkleY);
  ctx.lineTo(rAnkleX + u * 1.0, rFootY);
  ctx.stroke();

  // Eye
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(headX + u * 0.5, headY - u * 0.2, u * 0.38, 0, Math.PI * 2);
  ctx.fill();
  // Pupil
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(headX + u * 0.6, headY - u * 0.2, u * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Kelp Leviathan — aquatic predator
 * Torpedo body, dorsal spines, forked fluke tail, underslung jaw with teeth.
 * Trait = Hunting Range → jaw size + fin length.
 * Improvements: gill slits, lateral line, fluke tail (not simple fork),
 * lower jaw underslung beneath snout, more pronounced body taper.
 */
function _drawLeviathan(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const bodyLen = u * 15;

  // Body — asymmetric torpedo: blunt nose, strong taper to caudal peduncle
  ctx.lineWidth = u * 0.8;
  ctx.beginPath();
  // Upper profile
  ctx.moveTo(cx + bodyLen * 0.5, cy - u * 0.5);      // snout top
  ctx.bezierCurveTo(
    cx + bodyLen * 0.3, cy - u * 4,                   // shoulder (deepest)
    cx - bodyLen * 0.2, cy - u * 3.5,                 // mid-dorsal
    cx - bodyLen * 0.5, cy                            // caudal peduncle
  );
  // Lower profile (slightly flatter belly)
  ctx.bezierCurveTo(
    cx - bodyLen * 0.2, cy + u * 2.5,                 // belly-rear
    cx + bodyLen * 0.3, cy + u * 3.0,                 // belly-front
    cx + bodyLen * 0.5, cy + u * 0.8                  // chin
  );
  ctx.closePath();
  ctx.globalAlpha = 0.12;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  // Caudal fluke (whale-style, not simple fork)
  ctx.lineWidth = u * 0.7;
  ctx.globalAlpha = 0.7;
  const flukeW = u * (2.5 + trait * 1.5);
  const flukeX = cx - bodyLen * 0.5;
  ctx.beginPath();
  // Upper fluke
  ctx.moveTo(flukeX, cy - u * 0.5);
  ctx.bezierCurveTo(flukeX - u * 2, cy - u * 1.5, flukeX - u * 5, cy - flukeW,
                    flukeX - u * 5, cy - flukeW * 1.2);
  ctx.stroke();
  // Lower fluke
  ctx.beginPath();
  ctx.moveTo(flukeX, cy + u * 0.5);
  ctx.bezierCurveTo(flukeX - u * 2, cy + u * 1.5, flukeX - u * 5, cy + flukeW,
                    flukeX - u * 5, cy + flukeW * 1.2);
  ctx.stroke();
  // Fluke notch connector
  ctx.lineWidth = u * 0.5;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(flukeX - u * 5, cy - flukeW * 1.2);
  ctx.quadraticCurveTo(flukeX - u * 6.5, cy, flukeX - u * 5, cy + flukeW * 1.2);
  ctx.stroke();

  // Dorsal spines (fin with connected base)
  const spineCount = 3;
  ctx.lineWidth = u * 0.5;
  ctx.globalAlpha = 0.6;
  const finBaseX = cx - bodyLen * 0.08;
  // Dorsal fin base arc
  ctx.beginPath();
  ctx.moveTo(finBaseX - u * 3, cy - u * 3.5);
  for (let i = 0; i < spineCount; i++) {
    const sx = finBaseX - u * 3 + i * u * 3;
    const spineH = u * (2 + trait * 2 + (i === 1 ? 0.5 : 0)); // middle spine tallest
    ctx.lineTo(sx, cy - u * 3.5 - spineH);
    if (i < spineCount - 1) ctx.lineTo(sx + u * 1.5, cy - u * 3.0);
  }
  ctx.stroke();

  // Jaw — underslung: snout extends past lower jaw; trait widens gape
  const snoutX = cx + bodyLen * 0.5;
  const jawGape = u * (1.5 + trait * 2.5);
  ctx.lineWidth = u * 0.9;
  ctx.globalAlpha = 0.8;
  // Upper jaw (pointed snout)
  ctx.beginPath();
  ctx.moveTo(snoutX, cy - u * 0.5);
  ctx.lineTo(snoutX + u * 3.5, cy - u * 0.3);
  ctx.stroke();
  // Lower jaw (drops down)
  ctx.beginPath();
  ctx.moveTo(snoutX, cy + u * 0.8);
  ctx.lineTo(snoutX + u * 2.5, cy + jawGape);
  ctx.stroke();
  // Teeth (tiny triangles on lower jaw, scale with trait)
  ctx.lineWidth = u * 0.3;
  ctx.globalAlpha = 0.5;
  const toothCount = 1 + Math.round(trait * 3);
  for (let i = 0; i < toothCount; i++) {
    const tx = snoutX + u * 0.5 + i * u * 0.7;
    const ty = cy + u * 1.0 + i * jawGape * 0.25;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + u * 0.2, ty + u * 0.6);
    ctx.lineTo(tx + u * 0.5, ty);
    ctx.stroke();
  }

  // Pectoral fin — swept back
  const finLen = u * (2.5 + trait * 2.5);
  ctx.lineWidth = u * 0.6;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(cx + u * 3, cy + u * 2.5);
  ctx.bezierCurveTo(cx + u * 1, cy + u * 2.5 + finLen * 0.4,
                    cx - u * 2, cy + u * 2.5 + finLen,
                    cx - u * 1, cy + u * 2.5 + finLen * 0.7);
  ctx.stroke();

  // Gill slits — 3 curved lines behind eye area
  ctx.lineWidth = u * 0.4;
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < 3; i++) {
    const gx = cx + bodyLen * 0.28 - i * u * 1.2;
    ctx.beginPath();
    ctx.arc(gx, cy, u * 2.2, Math.PI * 0.55, Math.PI * 0.88);
    ctx.stroke();
  }

  // Lateral line — faint dashed line along mid-body
  ctx.lineWidth = u * 0.3;
  ctx.globalAlpha = 0.25;
  ctx.setLineDash([u * 1, u * 1.2]);
  ctx.beginPath();
  ctx.moveTo(cx + bodyLen * 0.4, cy - u * 0.5);
  ctx.bezierCurveTo(cx, cy - u * 1, cx - bodyLen * 0.3, cy - u * 0.5, cx - bodyLen * 0.45, cy);
  ctx.stroke();
  ctx.setLineDash([]);

  // Eye
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(cx + bodyLen * 0.33, cy - u * 1.2, u * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.arc(cx + bodyLen * 0.35, cy - u * 1.2, u * 0.24, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Reed Crawler — burrowing herbivore
 * Segmented caterpillar body. Trait = Burrowing Depth.
 * High trait: more segments, more compressed (flatter).
 * Improvements: tapered segment sizes (mid-body largest), pronotum (head shield),
 * leg joints with knee bends, head rounder than body.
 */
function _drawCrawler(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = u * 0.7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const segments = 3 + Math.round(trait * 4); // 3–7
  const squash = 1 - trait * 0.35;            // vertical compression when deep
  const maxSegR = u * (2.5 - trait * 0.4);    // max segment radius (mid-body)
  const segSpacing = maxSegR * 1.35;

  // Build tapering radii: largest in middle, smaller at each end
  const radii = [];
  for (let i = 0; i < segments; i++) {
    const t = i / (segments - 1); // 0=head, 1=tail
    // Bell curve: peaks at 0.3 from head (thorax), tapers to both ends
    const bell = Math.exp(-Math.pow((t - 0.3) * 2.5, 2));
    radii.push(maxSegR * (0.55 + 0.45 * bell));
  }

  const totalWidth = segments * segSpacing;
  const startX = cx - totalWidth / 2 + segSpacing * 0.5;

  // Draw segments back-to-front so head overlaps
  for (let i = segments - 1; i >= 0; i--) {
    const sx = startX + i * segSpacing;
    const sr = radii[i];
    const isHead = i === 0;

    // Slightly larger head shield (pronotum)
    const segW = isHead ? sr * 1.1 : sr;
    const segH = isHead ? sr * 1.0 * squash : sr * squash;

    ctx.beginPath();
    ctx.ellipse(sx, cy, segW, segH, 0, 0, Math.PI * 2);
    ctx.globalAlpha = isHead ? 0.22 : 0.08;
    ctx.fill();
    ctx.globalAlpha = isHead ? 0.85 : 0.72;
    ctx.stroke();

    // Segment crease lines (horizontal stripe on each segment)
    if (!isHead && i < segments - 1) {
      ctx.globalAlpha = 0.15;
      ctx.lineWidth = u * 0.3;
      ctx.beginPath();
      ctx.ellipse(sx, cy, segW * 0.85, segH * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = u * 0.7;
    }

    // Legs with knee joints (on segments 1 through n-2)
    if (i > 0 && i < segments - 1) {
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = u * 0.4;
      const legBaseY = cy + segH;
      for (const side of [-1, 1]) {
        const kx = sx + side * sr * 0.3;
        const ky = legBaseY + u * 1.3; // knee
        const fx = sx + side * sr * 1.0;
        const fy = legBaseY + u * 2.8; // foot
        ctx.beginPath();
        ctx.moveTo(sx, legBaseY);
        ctx.lineTo(kx, ky);
        ctx.lineTo(fx, fy);
        ctx.stroke();
      }
      ctx.lineWidth = u * 0.7;
    }
  }

  // Antennae from head
  const headX = startX;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = u * 0.5;
  ctx.beginPath();
  ctx.moveTo(headX, cy - radii[0] * squash);
  ctx.bezierCurveTo(headX - u * 2.5, cy - radii[0] - u * 3,
                    headX - u * 4.5, cy - radii[0] - u * 2,
                    headX - u * 5.5, cy - radii[0]);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(headX, cy - radii[0] * squash);
  ctx.bezierCurveTo(headX - u * 1.0, cy - radii[0] - u * 4.5,
                    headX + u * 1.0, cy - radii[0] - u * 3.5,
                    headX + u * 1.5, cy - radii[0] - u * 1.5);
  ctx.stroke();
  // Antenna tips
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(headX - u * 5.5, cy - radii[0], u * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(headX + u * 1.5, cy - radii[0] - u * 1.5, u * 0.3, 0, Math.PI * 2);
  ctx.fill();

  // Eye
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(headX + u * 0.8, cy - u * 0.5, u * 0.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.arc(headX + u * 0.9, cy - u * 0.5, u * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Tidal Crab — armored scavenger
 * Hexagonal carapace, asymmetric claws, stalked eyes.
 * Trait = Shell Thickness → body width + outline weight.
 * Improvements: proper hexagonal body path, improved claw pincers,
 * more natural leg angles in walking pose.
 */
function _drawCrab(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const bodyW = u * (5 + trait * 3);
  const bodyH = u * (3.5 + trait * 1.2);
  ctx.lineWidth = u * (0.5 + trait * 0.9);

  // Hexagonal carapace: 6 vertices approximating crab shape
  // Top-wide, bottom-narrow (real crab silhouette)
  function crabPath() {
    ctx.beginPath();
    const pts = [
      [cx - bodyW * 0.55, cy - bodyH * 0.0],   // far-left mid
      [cx - bodyW * 0.40, cy - bodyH * 0.85],   // left-top
      [cx + bodyW * 0.40, cy - bodyH * 0.85],   // right-top
      [cx + bodyW * 0.55, cy - bodyH * 0.0],   // far-right mid
      [cx + bodyW * 0.35, cy + bodyH * 0.75],   // right-bottom
      [cx - bodyW * 0.35, cy + bodyH * 0.75],   // left-bottom
    ];
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      // Smooth corners via quadratic to midpoints
      const next = pts[(i + 1) % pts.length];
      const mx = (pts[i][0] + next[0]) / 2;
      const my = (pts[i][1] + next[1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.closePath();
  }

  crabPath();
  ctx.globalAlpha = 0.14;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  // Shell ridges (concentric, inner)
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = u * 0.35;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(0.65, 0.65);
  ctx.translate(-cx, -cy);
  crabPath();
  ctx.stroke();
  ctx.restore();

  // Legs — 3 per side, jointed walking pose
  ctx.lineWidth = u * 0.5;
  const legAngles = [0.62, 0.88, 1.15]; // outward angles per leg (rad from horiz)
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const angle = legAngles[i];
      const attachX = cx + side * bodyW * (0.30 + i * 0.08);
      const attachY = cy + bodyH * 0.1;
      // Upper leg
      const kneeX = attachX + side * Math.cos(angle) * u * 3;
      const kneeY = attachY + Math.sin(angle) * u * 2.5;
      // Lower leg (bent down)
      const footX = kneeX + side * Math.cos(angle * 0.4) * u * 3;
      const footY = kneeY + Math.sin(angle * 1.4) * u * 3;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(attachX, attachY);
      ctx.lineTo(kneeX, kneeY);
      ctx.lineTo(footX, footY);
      ctx.stroke();
    }
  }

  // Big claw (right) — proper pincer with two arms
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = u * 0.7;
  const bigClawBase = [cx + bodyW * 0.5, cy - bodyH * 0.35];
  const bigClawMid  = [bigClawBase[0] + u * 2.5, bigClawBase[1] - u * 2];
  const bigClawTop  = [bigClawMid[0] + u * 2,    bigClawMid[1] - u * 1.5];
  const bigClawBot  = [bigClawMid[0] + u * 2.5,  bigClawMid[1] + u * 1.0];
  ctx.beginPath();
  ctx.moveTo(bigClawBase[0], bigClawBase[1]);
  ctx.lineTo(bigClawMid[0], bigClawMid[1]);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bigClawMid[0], bigClawMid[1]);
  ctx.lineTo(bigClawTop[0], bigClawTop[1]);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bigClawMid[0], bigClawMid[1]);
  ctx.lineTo(bigClawBot[0], bigClawBot[1]);
  ctx.stroke();

  // Small claw (left) — simpler
  ctx.lineWidth = u * 0.55;
  const smClawBase = [cx - bodyW * 0.5, cy - bodyH * 0.3];
  ctx.beginPath();
  ctx.moveTo(smClawBase[0], smClawBase[1]);
  ctx.lineTo(smClawBase[0] - u * 2, smClawBase[1] - u * 1.5);
  ctx.lineTo(smClawBase[0] - u * 2.8, smClawBase[1] - u * 0.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(smClawBase[0] - u * 2, smClawBase[1] - u * 1.5);
  ctx.lineTo(smClawBase[0] - u * 2.5, smClawBase[1] - u * 2.5);
  ctx.stroke();

  // Eyes on stalks
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#fff';
  ctx.shadowBlur = 0;
  ctx.lineWidth = u * 0.35;
  for (const side of [-1, 1]) {
    const stalkX = cx + side * u * 2.2;
    const stalkBaseY = cy - bodyH * 0.85;
    const eyeX = stalkX + side * u * 0.8;
    const eyeY = stalkBaseY - u * 1.8;
    // Stalk
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.moveTo(stalkX, stalkBaseY);
    ctx.lineTo(eyeX, eyeY);
    ctx.stroke();
    // Eye globe
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(eyeX, eyeY, u * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(eyeX + side * u * 0.1, eyeY, u * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Bioluminescent Worm — detritivore
 * Sinusoidal body, glow spots along length.
 * Trait = Glow Intensity → spot count, glow radius, brightness.
 * Improvements: tapered body (thick mid, thin ends), head bristle fringe,
 * slightly more complex wave (two overlapping frequencies), tapered tail.
 */
function _drawWorm(ctx, cx, cy, u, trait, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';

  const bodyLen = u * 22;
  const startX = cx - bodyLen / 2;
  const waveFreq = 2.0;
  const amplitude = u * 3.2;

  // Taper: body width varies from thin ends to thick middle
  // Point on wave: t=0 is head end, t=1 is tail
  function getWaveY(t) {
    return cy + Math.sin(t * Math.PI * waveFreq) * amplitude
              + Math.sin(t * Math.PI * waveFreq * 0.6 + 0.8) * amplitude * 0.2;
  }
  function getTaper(t) {
    // Bell curve: thickest at ~40% from head, thin at both ends
    return u * (0.5 + 2.0 * Math.exp(-Math.pow((t - 0.4) * 2.2, 2)));
  }

  // Draw tapered body as thick path (simulate variable width with multiple strokes)
  // Pass 1: thick translucent tube
  ctx.lineWidth = u * 2.8;
  ctx.globalAlpha = 0.08;
  ctx.beginPath();
  for (let t = 0; t <= 1; t += 0.02) {
    const x = startX + t * bodyLen;
    const y = getWaveY(t);
    if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Pass 2: main body outline
  ctx.lineWidth = u * 1.3;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  for (let t = 0; t <= 1; t += 0.02) {
    const x = startX + t * bodyLen;
    const y = getWaveY(t);
    if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Head — rounded bulge with sensory bristles
  const headX = startX;
  const headY = getWaveY(0);
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = u * 0;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(headX, headY, u * 1.8, 0, Math.PI * 2);
  ctx.fill();
  // Bristle fringe at head
  ctx.lineWidth = u * 0.35;
  ctx.globalAlpha = 0.5;
  const bristleCount = 5;
  for (let i = 0; i < bristleCount; i++) {
    const angle = -Math.PI * 0.3 + (i / (bristleCount - 1)) * Math.PI * 0.6 - Math.PI;
    const bLen = u * (1.0 + Math.sin(i * 1.3) * 0.5);
    ctx.beginPath();
    ctx.moveTo(headX + Math.cos(angle) * u * 1.5, headY + Math.sin(angle) * u * 1.5);
    ctx.lineTo(headX + Math.cos(angle) * (u * 1.5 + bLen),
               headY + Math.sin(angle) * (u * 1.5 + bLen));
    ctx.stroke();
  }

  // Tail tip — tapered point
  const tailX = startX + bodyLen;
  const tailY = getWaveY(1);
  ctx.lineWidth = u * 0.5;
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tailX + u * 2.0, tailY + Math.sign(Math.sin(Math.PI * waveFreq)) * u * 0.5);
  ctx.stroke();

  // Glow spots along body
  const spotCount = 3 + Math.round(trait * 5); // 3–8
  const glowR = u * (1.0 + trait * 2.2);
  ctx.shadowBlur = glowR * 2;
  ctx.shadowColor = color;

  for (let i = 0; i < spotCount; i++) {
    const t = (i + 0.8) / (spotCount + 0.6); // avoid very ends
    const x = startX + t * bodyLen;
    const y = getWaveY(t);
    const r = glowR * getTaper(t) / (u * 2.5); // scale glow with body width

    const grd = ctx.createRadialGradient(x, y, 0, x, y, Math.max(u * 0.5, r));
    grd.addColorStop(0, hexToRgba(color, 0.3 + trait * 0.5));
    grd.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = grd;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(u * 0.5, r), 0, Math.PI * 2);
    ctx.fill();

    // Bright spot center
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.35 + trait * 0.45;
    ctx.beginPath();
    ctx.arc(x, y, u * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Local helper (duplicated from ui.js to avoid circular dependency)
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
