'use strict';

/*
 * Draws the dashboard widget previews as Homey's guideline 1.10 asks: simple shapes,
 * no text, few colors, transparent background, 1024x1024, light and dark.
 * The shapes follow the widget's layout: header with status pill, COP and power graph,
 * temperature tiles and mode chips.
 *
 *   node scripts/widget-preview.js            writes the SVG files to docs/widget-preview/
 *   node scripts/widget-preview.js --png      also writes the PNG files; needs
 *                                             @resvg/resvg-js (not a project dependency),
 *                                             found through NODE_PATH
 */

const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const OUT = path.join(__dirname, '..', 'widgets', 'status');
// The SVG sources go to docs/, which isn't part of the app package.
const SVG_OUT = path.join(__dirname, '..', 'docs', 'widget-preview');

// The widget's accent (see widgets/status/public/index.html) and three neutrals.
const THEMES = {
  light: {
    accent: '#00876A', soft: '#C4E3DB', tile: '#DADDE2', bar: '#A6ACB4', strong: '#5C636B',
  },
  dark: {
    accent: '#26A882', soft: '#1F4A3E', tile: '#454950', bar: '#6E747C', strong: '#C9CDD2',
  },
};

const rect = (x, y, width, height, radius, fill) => (
  `  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"/>`
);
const circle = (cx, cy, r, fill) => `  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
// A rounded bar standing for a line of text.
const pill = (x, y, width, height, fill) => rect(x, y, width, height, height / 2, fill);

function svg(theme) {
  const {
    accent, soft, tile, bar, strong,
  } = theme;
  const line = 'M 520 380 L 586 380 L 636 262 L 716 250 L 790 280 L 862 266 L 928 286';

  const shapes = [
    // Header: name and status pill.
    pill(96, 104, 300, 52, strong),
    pill(716, 100, 212, 60, tile),
    circle(752, 130, 15, accent),
    pill(786, 118, 110, 24, bar),

    // The large COP value with its label.
    rect(96, 224, 308, 116, 34, strong),
    pill(96, 372, 240, 28, bar),

    // Power graph of the last hour.
    `  <path d="${line} L 928 404 L 520 404 Z" fill="${soft}"/>`,
    `  <path d="${line}" fill="none" stroke="${accent}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`,
    circle(928, 286, 20, accent),
  ];

  // Two rows of temperature tiles, each with a symbol and a value.
  for (const y of [468, 638]) {
    for (const x of [96, 528]) {
      shapes.push(
        rect(x, y, 400, 140, 36, tile),
        circle(x + 72, y + 70, 30, bar),
        pill(x + 144, y + 50, 200, 40, strong),
      );
    }
  }

  // Active modes.
  for (const x of [96, 460]) {
    shapes.push(
      pill(x, 840, 332, 84, soft),
      circle(x + 52, 882, 22, accent),
      pill(x + 96, 868, 190, 28, accent),
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    ...shapes,
    '</svg>',
    '',
  ].join('\n');
}

const png = process.argv.includes('--png');
// eslint-disable-next-line n/no-missing-require
const Resvg = png ? require(require.resolve('@resvg/resvg-js', { paths: (process.env.NODE_PATH || '').split(path.delimiter) })).Resvg : null;

for (const [name, theme] of Object.entries(THEMES)) {
  const drawing = svg(theme);
  fs.mkdirSync(SVG_OUT, { recursive: true });
  fs.writeFileSync(path.join(SVG_OUT, `preview-${name}.svg`), drawing);
  if (Resvg) fs.writeFileSync(path.join(OUT, `preview-${name}.png`), new Resvg(drawing).render().asPng());
  console.log(`preview-${name}: ${png ? 'svg and png' : 'svg'}`);
}
