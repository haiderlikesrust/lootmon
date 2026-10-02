import type { Game } from './game';

const cardinal = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const normalize = (angle: number) => ((angle % 360) + 360) % 360;

export function startNavigationHUD(game: Game, getBase: () => { x: number; z: number } | undefined) {
  const compass = document.querySelector<HTMLElement>('.compass')!;
  const tape = document.querySelector<HTMLElement>('#compass-tape')!;
  const heading = document.querySelector<HTMLElement>('#compass-heading')!;
  const home = document.querySelector<HTMLElement>('#compass-home')!;
  const fps = document.querySelector<HTMLElement>('#fps-value')!;
  const ticks = Array.from({ length: 17 }, () => {
    const tick = document.createElement('span');
    tick.className = 'compass-tick'; tape.append(tick); return tick;
  });
  let lastStats = 0;
  const frame = (now: number) => {
    if (!document.hidden) {
      const bearing = game.compassHeadingDegrees;
      const center = Math.floor(bearing / 15);
      ticks.forEach((tick, index) => {
        const angle = (center + index - 8) * 15;
        const isLabel = angle % 45 === 0;
        tick.textContent = isLabel ? cardinal[Math.round(normalize(angle) / 45) % 8] : '';
        tick.classList.toggle('major', isLabel);
        tick.style.transform = `translateX(${(angle - bearing) * 1.65}px)`;
      });
      const label = `${cardinal[Math.round(bearing / 45) % 8]} ${Math.round(bearing) % 360}°`;
      heading.textContent = label;
      compass.setAttribute('aria-label', `Camera heading ${label}`);
      const base = game.controlling ? getBase() : undefined;
      home.hidden = !base;
      if (base) {
        const position = game.explorationPosition;
        const target = normalize(Math.atan2(base.x - position.x, -(base.z - position.z)) * 180 / Math.PI);
        const delta = normalize(target - bearing + 180) - 180;
        home.style.transform = `translateX(${Math.max(-109, Math.min(109, delta * 1.65))}px)`;
        home.textContent = Math.abs(delta) > 66 ? (delta < 0 ? '‹ ⌂' : '⌂ ›') : '⌂';
        home.title = `${game.exploring ? 'Starting camp' : 'Your base'} · ${Math.round(Math.hypot(base.x-position.x, base.z-position.z))}m`;
      }
      if (now-lastStats >= 500) {
        lastStats = now;
        fps.textContent = game.framesPerSecond ? String(Math.round(game.framesPerSecond)) : '—';
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
