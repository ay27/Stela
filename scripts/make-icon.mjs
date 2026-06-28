import sharp from "sharp";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = resolve(root, "stela_icon.png");
const out = resolve(root, "stela_icon_rounded.png");

// macOS Big Sur+ icon spec:
// - 1024x1024 canvas
// - Squircle body: 824x824 centered (≈100px transparent margin each side)
// - Corner radius ratio ≈ 0.2237 of body size
const CANVAS = 1024;
const BODY = 824;
const RADIUS = Math.round(BODY * 0.2237);
const OFFSET = (CANVAS - BODY) / 2;
const CONTENT_PADDING = 110;
const CONTENT_SIZE = BODY - CONTENT_PADDING * 2;

function backgroundSvg(size, radius) {
  // Pure white squircle so the logo's own white backdrop blends in seamlessly.
  // A 1px inner stroke gives the icon a subtle edge against light wallpapers.
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#ffffff"/>
       <rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${radius}" ry="${radius}" fill="none" stroke="#0000001a" stroke-width="1"/>
     </svg>`,
  );
}

async function build() {
  // Trim transparent / near-white margins from the source so the logo
  // actually fills the available space inside the squircle.
  const trimmed = await sharp(src)
    .ensureAlpha()
    .trim({ threshold: 10 })
    .toBuffer();

  const logo = await sharp(trimmed)
    .resize(CONTENT_SIZE, CONTENT_SIZE, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer();

  const body = await sharp(backgroundSvg(BODY, RADIUS))
    .composite([
      { input: logo, top: CONTENT_PADDING, left: CONTENT_PADDING },
    ])
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: body, top: OFFSET, left: OFFSET }])
    .png()
    .toFile(out);

  console.log("wrote", out);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
