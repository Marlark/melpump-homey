'use strict';

/*
 * Makes the three App Store images from one photo: cropped to 10:7 around the middle,
 * without borders, as PNG in assets/images/.
 *
 *   node scripts/app-images.js photo.jpg [top|middle|bottom]
 *
 * The photo (.jpg or .png) should be at least 1000x700 pixels. The second argument
 * says which part to keep when the photo is too tall. Needs @resvg/resvg-js (not a
 * project dependency), found through NODE_PATH.
 */

const fs = require('fs');
const path = require('path');

const SIZES = { small: [250, 175], large: [500, 350], xlarge: [1000, 700] };
const ALIGN = { top: 'xMidYMin', middle: 'xMidYMid', bottom: 'xMidYMax' };

const [file, part = 'middle'] = process.argv.slice(2);
const type = file && { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[path.extname(file).toLowerCase()];
if (!type || !ALIGN[part]) {
  console.error('Usage: node scripts/app-images.js photo.jpg [top|middle|bottom]');
  process.exit(1);
}

// eslint-disable-next-line n/no-missing-require
const { Resvg } = require(require.resolve('@resvg/resvg-js', { paths: (process.env.NODE_PATH || '').split(path.delimiter) }));

const data = `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
const out = path.join(__dirname, '..', 'assets', 'images');
for (const [name, [width, height]] of Object.entries(SIZES)) {
  const drawing = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<image href="${data}" width="${width}" height="${height}" preserveAspectRatio="${ALIGN[part]} slice"/></svg>`;
  fs.writeFileSync(path.join(out, `${name}.png`), new Resvg(drawing).render().asPng());
  console.log(`assets/images/${name}.png ${width}x${height}`);
}
