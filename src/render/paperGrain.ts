/** The grain of the paper, drawn once for the size of the window and laid
 * behind the text as an image that never repeats.
 *
 * **Why an image drawn once, and not a filter or a tile.** A page of 和紙 is
 * not flat: it has a cloudy formation where the fibres lie thicker or
 * thinner, a fine tooth, and here and there a fibre lying on the surface,
 * all of them plain in the NDL scans the palette was measured from (see
 * DESIGN.md, "Colors"). A tile repeats, and the eye finds the repeat within
 * a screen, which the reader asked not to have. An SVG `feTurbulence` filter
 * over a fixed layer would not repeat, but the browser runs a filter of that
 * kind on the processor for every pixel it covers, again on every resize,
 * and again wherever anything above the layer is repainted. So the grain is
 * computed here once, in script, into a canvas the size of the screen, and
 * handed to the CSS as an image: after that it costs what any other
 * background image costs, which is nothing while the panels scroll, because
 * the layer it sits on does not scroll.
 *
 * **Stable across resizes.** Every value is a hash of its position in CSS
 * pixels, not a draw from a random stream, so a larger canvas drawn after
 * the window grows has the same grain, fibre for fibre, where the two
 * overlap, and a resize does not make the paper visibly change under the
 * text. The canvas is drawn for the larger of the window and the screen,
 * and drawn again only when the window outgrows it, when the pixel density
 * changes (the window moved to another display) or when the theme changes;
 * shrinking the window only shows less of the same image.
 *
 * **Centred on the page colour, in levels, so that the contrast stays where
 * the palette put it.** The grain is a translucent image over `--color-bg`,
 * and a translucent speck moves the ground by its alpha times the distance
 * from the ground to the colour of the speck. Over the light page that
 * distance is about 14 levels up to white and about 120 down to a shadow of
 * the paper, so a grain drawn with equal alphas both ways darkened the page
 * on average, by 2.5 levels at the first strength tried, which took the
 * okurigana from 4.58:1 to 4.48:1. So the alphas are solved per pixel
 * against the ground actually under them, read from `--color-bg`: every
 * speck asks for a change in levels, up or down, and gets the alpha that
 * makes exactly that change. The two sides then cancel, the mean of the
 * page is the token, and the same code serves the dark theme, where the
 * distances run the other way. The image is drawn again when the theme
 * changes, since its alphas belong to one ground. */

/** One 32-bit hash of two integers and a seed, mapped to [0, 1). A
 * multiply-xorshift mix, which is plenty for grain and costs a few integer
 * operations a pixel. */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/** Value noise on a square lattice of `cell` CSS pixels, eased between the
 * lattice points so that no grid line shows, added into the `w` by `h`
 * field at `weight`. */
function addValueNoise(out: Float32Array, w: number, h: number, cell: number, seed: number, weight: number): void {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const lattice = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) lattice[j * gw + i] = hash(i, j, seed) * 2 - 1;
  }
  const ease = new Float32Array(cell);
  for (let k = 0; k < cell; k++) {
    const t = k / cell;
    ease[k] = t * t * (3 - 2 * t);
  }
  for (let y = 0; y < h; y++) {
    const j = (y / cell) | 0;
    const ty = ease[y - j * cell];
    const row0 = j * gw;
    const row1 = row0 + gw;
    for (let x = 0; x < w; x++) {
      const i = (x / cell) | 0;
      const tx = ease[x - i * cell];
      const a = lattice[row0 + i] + (lattice[row0 + i + 1] - lattice[row0 + i]) * tx;
      const b = lattice[row1 + i] + (lattice[row1 + i + 1] - lattice[row1 + i]) * tx;
      out[y * w + x] += (a + (b - a) * ty) * weight;
    }
  }
}

/** The cloudy formation of the sheet, its tooth, and the white noise of
 * single fibres, summed into one field at CSS-pixel resolution, roughly in
 * [-1, 1]. The formation carries most of it, as it does on the scans; the
 * per-pixel noise is kept low enough that it never reads as the speckle of
 * a digital photograph. */
function grainField(w: number, h: number): Float32Array {
  const field = new Float32Array(w * h);
  addValueNoise(field, w, h, 61, 0x1a2b, 0.4);
  addValueNoise(field, w, h, 17, 0x3c4d, 0.3);
  addValueNoise(field, w, h, 4, 0x5e6f, 0.3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) field[y * w + x] += (hash(x, y, 0x7081) * 2 - 1) * 0.22;
  }
  return field;
}

/** **How far the grain moves the ground, in 8-bit levels per unit of the
 * field.** Chosen by eye at the strength where the paper reads as paper at
 * arm's length and as flat at a glance; measured on a screenshot of the
 * light theme, it comes to a standard deviation of about one level per
 * channel, against the 3.4 of the first, plainly mottled attempt. */
const LEVELS = 3.2;

/** The shadow of the paper that a darker speck is drawn in: the ground at
 * this share of itself, so that the dark of the grain is the paper's own
 * colour deepened rather than a grey laid over it. */
const SHADOW = 0.55;

type Rgb = [number, number, number];

/** The ground under the grain, from the token. Six-digit hex is all the
 * palette uses; anything else falls back to the light page. */
function readGround(root: HTMLElement): Rgb {
  const raw = getComputedStyle(root).getPropertyValue("--color-bg").trim();
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(raw);
  if (!m) return [250, 241, 223];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** The colour and alpha that move `ground` by `delta` levels: up toward
 * white, or down toward the shadow of the ground. Solved on the mean of the
 * three channels, which is close enough on a ground this near grey. */
function speck(ground: Rgb, delta: number): { rgb: Rgb; alpha: number } {
  const mean = (ground[0] + ground[1] + ground[2]) / 3;
  if (delta >= 0) return { rgb: [255, 255, 255], alpha: Math.min(1, delta / Math.max(1, 255 - mean)) };
  const shadow: Rgb = [ground[0] * SHADOW, ground[1] * SHADOW, ground[2] * SHADOW];
  return { rgb: shadow, alpha: Math.min(1, -delta / Math.max(1, mean * (1 - SHADOW))) };
}

/** Fibres lying on the surface: short, slightly curved hairlines, a few to
 * every hundred-pixel square, most of them lighter than the sheet (a fibre
 * catches the light) and a third darker (a fibre in shadow, or a fleck of
 * bark). Each moves the ground by a few levels, solved like the grain.
 * Seeded per 64px cell from its position, like the grain, so a larger
 * canvas repeats them where the smaller one had them. Drawn in CSS pixels
 * on a context already scaled to the device, so they stay hairlines on a
 * dense screen. */
function drawFibres(ctx: CanvasRenderingContext2D, w: number, h: number, ground: Rgb): void {
  const CELL = 64;
  ctx.lineCap = "round";
  for (let cy = 0; cy * CELL < h; cy++) {
    for (let cx = 0; cx * CELL < w; cx++) {
      const count = Math.floor(hash(cx, cy, 0x9a1) * 4);
      for (let n = 0; n < count; n++) {
        const r = (k: number) => hash(cx * 8 + n, cy * 8 + k, 0xb2c3);
        const x0 = (cx + r(0)) * CELL;
        const y0 = (cy + r(1)) * CELL;
        const angle = r(2) * Math.PI;
        const length = 6 + r(3) * 22;
        const bend = (r(4) - 0.5) * length * 0.5;
        const dx = Math.cos(angle) * length;
        const dy = Math.sin(angle) * length;
        const levels = (2 + r(6) * 3) * (r(5) < 0.33 ? -1 : 1);
        const { rgb, alpha } = speck(ground, levels);
        ctx.strokeStyle = `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${alpha})`;
        ctx.lineWidth = 0.35 + r(7) * 0.45;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(x0 + dx / 2 - (dy * bend) / length, y0 + dy / 2 + (dx * bend) / length, x0 + dx, y0 + dy);
        ctx.stroke();
      }
    }
  }
}

/** Above this many device pixels the canvas is drawn at a lower density and
 * the browser scales it up: a 5K display at 2x would otherwise ask for a
 * 60MB canvas for a texture nobody can see at the pixel. */
const MAX_DEVICE_PIXELS = 9_000_000;

interface Drawn {
  width: number;
  height: number;
  density: number;
  ground: string;
  url: string;
}

let drawn: Drawn | null = null;
let generation = 0;

/** Draws the grain for `width` by `height` CSS pixels at `density` device
 * pixels a CSS pixel over `ground`, and hands it to the CSS when the image
 * is encoded. */
function draw(width: number, height: number, density: number, ground: Rgb, root: HTMLElement): void {
  const mine = ++generation;
  const started = performance.now();

  const scale = Math.min(density, Math.sqrt(MAX_DEVICE_PIXELS / (width * height)));
  // The grain itself is computed at CSS-pixel resolution, where its finest
  // detail lives, and then drawn up to the device by the canvas with
  // smoothing; only the fibres, which are hairlines, are drawn at the
  // density of the device.
  const field = grainField(width, height);
  const base = document.createElement("canvas");
  base.width = width;
  base.height = height;
  const baseCtx = base.getContext("2d")!;
  const image = baseCtx.createImageData(width, height);
  const px = image.data;
  const up = speck(ground, LEVELS);
  const down = speck(ground, -LEVELS);
  for (let k = 0; k < field.length; k++) {
    const v = field[k];
    const s = v < 0 ? down : up;
    const o = k * 4;
    px[o] = s.rgb[0];
    px[o + 1] = s.rgb[1];
    px[o + 2] = s.rgb[2];
    px[o + 3] = Math.min(255, Math.abs(v) * s.alpha * 255);
  }
  baseCtx.putImageData(image, 0, 0);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawFibres(ctx, width, height, ground);
  const computed = performance.now();

  canvas.toBlob((blob) => {
    if (!blob || mine !== generation) return;
    const url = URL.createObjectURL(blob);
    const previous = drawn;
    drawn = { width, height, density, ground: ground.join(), url };
    root.style.setProperty("--paper-grain", `url("${url}")`);
    root.style.setProperty("--paper-grain-size", `${width}px ${height}px`);
    // Kept where a reader of the inspector can find it: the cost of the
    // texture, computing and then encoding, is the one claim about it that
    // can be checked on any machine.
    root.dataset.paperGrainMs = `${Math.round(computed - started)}+${Math.round(performance.now() - computed)}`;
    if (previous) URL.revokeObjectURL(previous.url);
  }, "image/png");
}

/** Lays the grain on the page and keeps it as large as the window and in
 * step with the theme. Call once, at startup. Forced colours replace the
 * page colour with a system one, and the grain is not drawn there at all
 * (paper.css), so it is not computed either. */
export function installPaperGrain(root: HTMLElement = document.documentElement): void {
  if (matchMedia("(forced-colors: active)").matches) return;

  const refresh = () => {
    const width = Math.ceil(Math.max(innerWidth, screen.width));
    const height = Math.ceil(Math.max(innerHeight, screen.height));
    const density = devicePixelRatio || 1;
    const ground = readGround(root);
    if (
      drawn &&
      width <= drawn.width &&
      height <= drawn.height &&
      density === drawn.density &&
      ground.join() === drawn.ground
    ) {
      return;
    }
    draw(Math.max(width, drawn?.width ?? 0), Math.max(height, drawn?.height ?? 0), density, ground, root);
  };

  // After first paint, so the text is up before the grain is computed: the
  // page reads perfectly well on the flat colour for the few frames the
  // grain takes to arrive.
  requestAnimationFrame(() => setTimeout(refresh, 0));

  let timer = 0;
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = window.setTimeout(refresh, 250);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh);
}
