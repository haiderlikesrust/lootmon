/** North-up cartography over the same orthographic world the player explores. */
export const MAP_EXTENT = 140;

export const DISTRICT_INFO = [
  { id: 'hearthwick', number: '01', name: 'Hearthwick', x: 0, z: 6, color: '#edcc8b', subtitle: 'Village center', description: 'Enter the cottages, search the market, and follow the lanes around the fountain.', labelOffset: [0, -18] },
  { id: 'whisperwood', number: '02', name: 'Whisperwood', x: -84, z: 55, color: '#9dc59b', subtitle: 'Western woodland', description: 'Winding woodland trails and deep tree cover around the western meadow.', labelOffset: [-3, -17] },
  { id: 'sunmill', number: '03', name: 'Sunmill Orchard', x: -92, z: 73, color: '#e4bc7a', subtitle: 'Windmill & gardens', description: 'The old windmill rises above fenced gardens and a sheltered orchard.', labelOffset: [12, 22] },
  { id: 'crown-ruins', number: '04', name: 'Crown Ruins', x: 95, z: -84, color: '#c3b2e2', subtitle: 'Ancient arches', description: 'Broken columns and stone arches sit beyond the northeastern lanes.', labelOffset: [-10, 16] },
  { id: 'silverwater', number: '05', name: 'Silverwater', x: 5, z: -104, color: '#9bd7d7', subtitle: 'River crossings', description: 'Two wooden bridges connect the valley with its northern foothills.', labelOffset: [-5, -17] },
  { id: 'old-watch', number: '06', name: 'Old Watch', x: 110, z: 77, color: '#d4ccaa', subtitle: 'Eastern lookout', description: 'A stone watchtower marks the far eastern edge of the woodland.', labelOffset: [-17, 20] },
] as const;

export type MapLandmark = { name: string; x: number; z: number; color: string };
export type MapPlayer = { id: string; name: string; x: number; z: number; yaw?: number; base: { x: number; z: number }; carrying?: string | null };
export type IslandMapOptions = {
  background: HTMLCanvasElement | null;
  landmarks: readonly MapLandmark[];
  players: readonly MapPlayer[];
  myId: string | null;
  explorer?: { x: number; z: number; yaw?: number } | null;
  explorerCamp?: { x: number; z: number } | null;
  localPosition?: { x: number; z: number; yaw?: number } | null;
  small?: boolean;
  selectedDistrict?: string | null;
};

function dimensions(canvas: HTMLCanvasElement, small = false) {
  const unit = Math.min(canvas.width, canvas.height) / 800;
  const inset = (small ? 12 : 30) * unit;
  const side = Math.min(canvas.width, canvas.height) - inset * 2;
  return { unit, side, left: (canvas.width - side) / 2, top: (canvas.height - side) / 2 };
}

/** Uses exactly the same inset/projection as drawIslandMap, including CSS scaling. */
export function mapPointFromCanvas(canvas: HTMLCanvasElement, clientX: number, clientY: number, small = false) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const { left, top, side } = dimensions(canvas, small);
  const x = (clientX - rect.left) * canvas.width / rect.width;
  const y = (clientY - rect.top) * canvas.height / rect.height;
  if (x < left || y < top || x > left + side || y > top + side) return null;
  return { x: (x - left) / side * MAP_EXTENT * 2 - MAP_EXTENT, z: (y - top) / side * MAP_EXTENT * 2 - MAP_EXTENT };
}

export function drawIslandMap(canvas: HTMLCanvasElement, options: IslandMapOptions) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.width || !canvas.height) return;
  const { small = false, background, landmarks, players, myId, explorer, explorerCamp, localPosition, selectedDistrict } = options;
  const { unit: u, side, left, top } = dimensions(canvas, small);
  const right = left + side, bottom = top + side, scale = side / (MAP_EXTENT * 2);
  const px = (x: number) => left + (x + MAP_EXTENT) * scale;
  const pz = (z: number) => top + (z + MAP_EXTENT) * scale;
  const font = (size: number, weight = 500) => `${weight} ${size * u}px "Inter", "Segoe UI", sans-serif`;
  const rounded = (x: number, y: number, w: number, h: number, radius: number) => {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
  };
  const tracked = (text: string, x: number, y: number, spacing: number) => {
    ctx.textAlign = 'left';
    for (const character of text) { ctx.fillText(character, x, y); x += ctx.measureText(character).width + spacing; }
  };
  const disk = (x: number, y: number, radius: number, fill: string, stroke?: string, width = 1) => {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width * u; ctx.stroke(); }
  };

  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#112b26'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save(); rounded(left, top, side, side, (small ? 16 : 9) * u); ctx.clip();

  if (background && background.width && background.height) {
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(background, left, top, side, side);
    // Quiet the aerial colors just enough for wayfinding, retaining real roof,
    // woodland, river and street geometry beneath all of the map annotations.
    ctx.fillStyle = 'rgba(13, 48, 35, .12)'; ctx.fillRect(left, top, side, side);
  } else {
    const terrain = ctx.createLinearGradient(left, top, right, bottom);
    terrain.addColorStop(0, '#638578'); terrain.addColorStop(.44, '#859b72'); terrain.addColorStop(1, '#4d7863');
    ctx.fillStyle = terrain; ctx.fillRect(left, top, side, side);
    // Neutral relief during snapshot creation. No invented roads or buildings.
    for (const [x, z, radius] of [[-90, -62, 65], [104, 60, 68], [-85, 68, 57], [80, -115, 52]]) {
      const relief = ctx.createRadialGradient(px(x), pz(z), 0, px(x), pz(z), radius * scale);
      relief.addColorStop(0, 'rgba(29,65,51,.4)'); relief.addColorStop(1, 'rgba(29,65,51,0)');
      ctx.fillStyle = relief; ctx.fillRect(left, top, side, side);
      ctx.strokeStyle = 'rgba(205,229,185,.08)'; ctx.lineWidth = u;
      for (let ring = 0; ring < 5; ring++) {
        ctx.beginPath(); ctx.ellipse(px(x), pz(z), (radius - ring * 7) * scale, (radius - ring * 7) * scale * .75, -.4, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  const vignette = ctx.createRadialGradient(left + side * .5, top + side * .45, side * .23, left + side * .5, top + side * .5, side * .75);
  vignette.addColorStop(0, 'rgba(8,34,26,0)'); vignette.addColorStop(.72, 'rgba(8,34,26,.05)'); vignette.addColorStop(1, 'rgba(8,34,26,.63)');
  ctx.fillStyle = vignette; ctx.fillRect(left, top, side, side);

  if (!small) {
    // Six discreet survey columns replace the former invented road grid.
    ctx.strokeStyle = 'rgba(230,245,217,.11)'; ctx.lineWidth = .75 * u; ctx.setLineDash([2 * u, 7 * u]);
    for (let i = 1; i < 6; i++) {
      const at = side * i / 6; ctx.beginPath(); ctx.moveTo(left + at, top); ctx.lineTo(left + at, bottom); ctx.moveTo(left, top + at); ctx.lineTo(right, top + at); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(220,244,205,.13)'; ctx.lineWidth = u;
    rounded(px(-124), pz(-124), 248 * scale, 248 * scale, 3 * u); ctx.stroke();
  }

  const me = players.find(player => player.id === myId);
  // A predicted live position updates the arrow without changing any server-owned
  // base, reward or rival data. An exploration camp is never an extraction base.
  const position = me ? localPosition ?? me : explorer;
  const destination = me ? me.base : explorer ? explorerCamp : null;
  const isCamp = !me;
  const carrying = Boolean(me?.carrying);
  const destinationColor = isCamp ? '#93eaff' : '#fff394';
  const destinationAccent = isCamp ? '#d8f9ff' : '#fffbd0';
  const homeDistance = position && destination ? Math.hypot(destination.x - position.x, destination.z - position.z) : null;
  let homeDirection = '';
  if (position && destination && homeDistance !== null) {
    const direction = Math.atan2(destination.x - position.x, position.z - destination.z);
    homeDirection = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][(Math.round(direction / (Math.PI / 4)) + 8) % 8];
    const fromX = px(position.x), fromY = pz(position.z), toX = px(destination.x), toY = pz(destination.z);
    const length = Math.hypot(toX - fromX, toY - fromY);
    const startInset = (small ? 23 : 14) * u, endInset = (small ? 35 : 23) * u;
    if (length > startInset + endInset + 8 * u) {
      const dx = (toX - fromX) / length, dy = (toY - fromY) / length;
      ctx.save(); ctx.lineCap = 'round';
      // This is a direct bearing, not a fabricated navigable road or hidden route.
      ctx.beginPath(); ctx.moveTo(fromX + dx * startInset, fromY + dy * startInset); ctx.lineTo(toX - dx * endInset, toY - dy * endInset);
      ctx.lineWidth = (small ? 10 : 5) * u; ctx.strokeStyle = 'rgba(11,37,29,.55)'; ctx.stroke();
      ctx.setLineDash([(small ? 13 : 8) * u, (small ? 11 : 7) * u]);
      ctx.lineWidth = (small ? carrying ? 5 : 4 : carrying ? 2.8 : 2) * u;
      ctx.strokeStyle = carrying ? '#fff7b5' : isCamp ? '#b8f1ff' : '#f2ebaf'; ctx.stroke(); ctx.setLineDash([]);
      const arrowSize = (small ? 12 : 7) * u;
      for (const fraction of length > 180 * u ? [.42, .7] : [.56]) {
        const along = startInset + (length - startInset - endInset) * fraction;
        const ax = fromX + dx * along, ay = fromY + dy * along;
        ctx.beginPath(); ctx.moveTo(ax - dx * arrowSize - dy * arrowSize * .6, ay - dy * arrowSize + dx * arrowSize * .6);
        ctx.lineTo(ax, ay); ctx.lineTo(ax - dx * arrowSize + dy * arrowSize * .6, ay - dy * arrowSize - dx * arrowSize * .6);
        ctx.lineWidth = (small ? 6 : 3.5) * u; ctx.strokeStyle = '#244a36'; ctx.stroke();
        ctx.lineWidth = (small ? 3.5 : 1.8) * u; ctx.strokeStyle = destinationAccent; ctx.stroke();
      }
      ctx.restore();
    }
  }

  const actualDistricts = landmarks.map((landmark, index) => ({ landmark, district: DISTRICT_INFO.find(d => d.name === landmark.name), index }));
  for (const { landmark, district } of actualDistricts) {
    const x = px(landmark.x), y = pz(landmark.z), selected = district?.id === selectedDistrict;
    if (selected) {
      disk(x, y, 14 * scale, 'rgba(218,250,169,.10)', 'rgba(230,255,193,.46)', 1);
      disk(x, y, 18 * scale, 'rgba(218,250,169,.02)', 'rgba(230,255,193,.16)', .8);
    }
    if (small) { disk(x, y, 4 * u, 'rgba(230,244,211,.65)', 'rgba(20,48,34,.9)', 1.5); continue; }
    const offset = district?.labelOffset ?? [0, -15];
    ctx.font = font(12, 650);
    const title = landmark.name.toUpperCase();
    const titleWidth = ctx.measureText(title).width + (title.length - 1) * .9 * u;
    const labelWidth = Math.max(132 * u, titleWidth + 56 * u), labelHeight = 44 * u;
    const centerX = Math.max(left + labelWidth / 2 + 9 * u, Math.min(right - labelWidth / 2 - 9 * u, px(landmark.x + offset[0])));
    const centerY = Math.max(top + labelHeight / 2 + 9 * u, Math.min(bottom - labelHeight / 2 - 9 * u, pz(landmark.z + offset[1])));
    const labelX = centerX - labelWidth / 2, labelY = centerY - labelHeight / 2;
    // Leader lines always terminate at the real landmark location.
    ctx.strokeStyle = selected ? '#e3fac2' : 'rgba(229,243,213,.6)'; ctx.lineWidth = 1.1 * u;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(centerX, centerY); ctx.stroke();
    disk(x, y, 4.5 * u, landmark.color, '#173f30', 2);
    disk(x, y, 9 * u, 'rgba(212,234,192,.03)', 'rgba(235,248,217,.5)', .8);
    ctx.save(); ctx.shadowColor = 'rgba(3,22,14,.28)'; ctx.shadowBlur = 9 * u; ctx.shadowOffsetY = 3 * u;
    rounded(labelX, labelY, labelWidth, labelHeight, 7 * u);
    ctx.fillStyle = selected ? 'rgba(45,78,48,.97)' : 'rgba(18,47,36,.90)'; ctx.fill(); ctx.restore();
    rounded(labelX, labelY, labelWidth, labelHeight, 7 * u);
    ctx.strokeStyle = selected ? '#e0f4b5' : 'rgba(220,240,203,.3)'; ctx.lineWidth = (selected ? 1.5 : .85) * u; ctx.stroke();
    disk(labelX + 22 * u, centerY, 12 * u, 'rgba(204,233,175,.05)', selected ? '#dbf6a8' : 'rgba(218,238,199,.5)', .9);
    ctx.font = font(10, 700); ctx.fillStyle = '#e0efcd'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(district?.number ?? '·', labelX + 22 * u, centerY + .5 * u);
    ctx.font = font(12, 650); ctx.fillStyle = '#e4efd2'; tracked(title, labelX + 42 * u, centerY - 7 * u, .9 * u);
    ctx.font = font(9.5, 450); ctx.fillStyle = selected ? '#c9deb5' : '#afc3a8'; ctx.textAlign = 'left';
    ctx.fillText(district?.subtitle ?? 'Valley landmark', labelX + 42 * u, centerY + 10 * u);
  }

  for (const player of players) {
    if (player.id === myId) continue;
    const x = px(player.x), y = pz(player.z);
    disk(x, y, (small ? 7 : 4.5) * u, player.carrying ? '#ffd28a' : '#f3b693', '#364335', 1.5);
    if (player.carrying) disk(x, y, (small ? 11 : 8) * u, 'rgba(249,192,111,.1)', 'rgba(255,218,158,.9)', 1);
  }
  if (position) {
    const x = px(position.x), y = pz(position.z), factor = small ? 1.7 : 1;
    disk(x, y, 17 * u * factor, 'rgba(212,248,135,.15)', 'rgba(223,255,168,.4)', 1);
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI - (position.yaw ?? 0)); ctx.scale(factor, factor);
    ctx.beginPath(); ctx.moveTo(0, -10 * u); ctx.lineTo(7 * u, 8 * u); ctx.lineTo(0, 4 * u); ctx.lineTo(-7 * u, 8 * u); ctx.closePath();
    ctx.shadowColor = 'rgba(16,35,20,.7)'; ctx.shadowBlur = 6 * u;
    ctx.fillStyle = '#e2ffa2'; ctx.strokeStyle = '#1c3c28'; ctx.lineWidth = 2 * u; ctx.fill(); ctx.stroke(); ctx.restore();
  }

  if (destination) {
    // Draw home last so it remains visible even when the player is standing on it.
    const x = px(destination.x), y = pz(destination.z), radius = (small ? 30 : 18) * u;
    const rim = radius + (small ? 8 : 5) * u;
    disk(x, y, rim, isCamp ? 'rgba(90,209,240,.2)' : 'rgba(255,235,107,.22)', destinationAccent, small ? 2.5 : 1.4);
    ctx.save(); ctx.shadowColor = isCamp ? 'rgba(129,225,255,.75)' : 'rgba(255,233,113,.75)'; ctx.shadowBlur = (small ? 15 : 10) * u;
    disk(x, y, radius, destinationColor, '#163e35', small ? 4 : 2.5); ctx.restore();
    ctx.save(); ctx.translate(x, y); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#244a38'; ctx.fillStyle = '#244a38'; ctx.lineWidth = (small ? 4 : 2.6) * u;
    if (isCamp) {
      ctx.beginPath(); ctx.moveTo(-radius * .26, radius * .5); ctx.lineTo(-radius * .26, -radius * .55); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-radius * .22, -radius * .49); ctx.lineTo(radius * .5, -radius * .3); ctx.lineTo(-radius * .22, -radius * .05); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-radius * .48, radius * .53); ctx.lineTo(radius * .18, radius * .53); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(-radius * .58, -radius * .06); ctx.lineTo(0, -radius * .55); ctx.lineTo(radius * .58, -radius * .06); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-radius * .4, -radius * .08); ctx.lineTo(-radius * .4, radius * .46); ctx.lineTo(radius * .4, radius * .46); ctx.lineTo(radius * .4, -radius * .08); ctx.closePath(); ctx.fill();
      ctx.fillStyle = destinationColor; ctx.fillRect(-radius * .12, radius * .08, radius * .24, radius * .38);
    }
    ctx.restore();
    const title = isCamp ? 'START CAMP' : 'YOUR BASE';
    const subtitle = homeDistance === null ? isCamp ? 'EXPLORATION' : 'EXTRACTION POINT'
      : homeDistance <= 4 ? 'YOU ARE HERE'
        : `${carrying ? 'RETURN · ' : ''}${Math.round(homeDistance)} m · ${homeDirection}`;
    ctx.font = font(small ? 27 : 12, 800);
    const titleWidth = ctx.measureText(title).width;
    ctx.font = font(small ? 23 : 10, 600);
    const labelWidth = Math.max(titleWidth, ctx.measureText(subtitle).width) + (small ? 28 : 20) * u;
    const labelHeight = (small ? 72 : 40) * u, gap = (small ? 12 : 9) * u;
    const labelX = Math.max(left + 8 * u, Math.min(right - labelWidth - 8 * u, x - labelWidth / 2));
    let labelY = y + radius + gap;
    if (labelY + labelHeight > bottom - 8 * u) labelY = y - radius - gap - labelHeight;
    labelY = Math.max(top + 8 * u, labelY);
    rounded(labelX, labelY, labelWidth, labelHeight, (small ? 10 : 6) * u);
    ctx.fillStyle = 'rgba(14,40,31,.97)'; ctx.fill(); ctx.strokeStyle = destinationColor; ctx.lineWidth = (small ? 2.5 : 1.3) * u; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = destinationAccent; ctx.font = font(small ? 27 : 12, 800);
    ctx.fillText(title, labelX + labelWidth / 2, labelY + labelHeight * .31);
    ctx.fillStyle = carrying ? '#fff3ad' : '#c5ded5'; ctx.font = font(small ? 23 : 10, 600);
    ctx.fillText(subtitle, labelX + labelWidth / 2, labelY + labelHeight * .73);
  }

  // Compact compass rose; the projection remains true north at every size.
  let cx = right - (small ? 45 : 38) * u;
  const cy = top + (small ? 51 : 42) * u;
  if (destination && Math.hypot(px(destination.x) - cx, pz(destination.z) - cy) < 90 * u) cx = left + (small ? 45 : 38) * u;
  if (!small) disk(cx, cy, 24 * u, 'rgba(19,46,34,.63)', 'rgba(225,241,205,.23)', .8);
  ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = '#e2edcc';
  ctx.beginPath(); ctx.moveTo(0, -13 * u); ctx.lineTo(4 * u, 4 * u); ctx.lineTo(0, u); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#71917a'; ctx.beginPath(); ctx.moveTo(0, -13 * u); ctx.lineTo(-4 * u, 4 * u); ctx.lineTo(0, u); ctx.closePath(); ctx.fill();
  ctx.font = font(small ? 26 : 10, 750); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#e1efd0'; ctx.fillText('N', 0, (small ? -28 : -32) * u); ctx.restore();

  if (!small) {
    // Physical scale and small field-guide signature keep the map grounded.
    const barX = left + 22 * u, barY = bottom - 27 * u, barWidth = 50 * scale;
    ctx.fillStyle = 'rgba(16,43,30,.73)'; rounded(barX - 10 * u, barY - 25 * u, barWidth + 20 * u, 39 * u, 5 * u); ctx.fill();
    ctx.strokeStyle = '#d7e9c5'; ctx.lineWidth = 1.5 * u;
    ctx.beginPath(); ctx.moveTo(barX, barY - 4 * u); ctx.lineTo(barX, barY); ctx.lineTo(barX + barWidth, barY); ctx.lineTo(barX + barWidth, barY - 4 * u); ctx.moveTo(barX + barWidth / 2, barY); ctx.lineTo(barX + barWidth / 2, barY - 4 * u); ctx.stroke();
    ctx.font = font(9, 500); ctx.fillStyle = '#deead0'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('0', barX - 2 * u, barY - 13 * u); ctx.textAlign = 'center'; ctx.fillText('25', barX + barWidth / 2, barY - 13 * u); ctx.textAlign = 'right'; ctx.fillText('50 m', barX + barWidth, barY - 13 * u);
    ctx.font = font(8.5, 650); ctx.fillStyle = 'rgba(226,241,213,.7)'; ctx.textAlign = 'right'; ctx.fillText('VERDANT ISLE  /  FIELD MAP 01', right - 18 * u, bottom - 16 * u);
  }
  ctx.restore();

  rounded(left, top, side, side, (small ? 16 : 9) * u); ctx.strokeStyle = 'rgba(212,232,192,.23)'; ctx.lineWidth = u; ctx.stroke();
  if (!small) {
    ctx.font = font(10, 650); ctx.fillStyle = '#8aa68d'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 6; i++) {
      const at = side * (i + .5) / 6;
      ctx.fillText(String.fromCharCode(65 + i), left + at, top / 2);
      ctx.fillText(String.fromCharCode(65 + i), left + at, bottom + (canvas.height - bottom) / 2);
      ctx.fillText(String(i + 1), left / 2, top + at);
      ctx.fillText(String(i + 1), right + (canvas.width - right) / 2, top + at);
    }
  }
  ctx.restore();
}
