// The splash's 16-bit pixel art, drawn for this app (no game sprites are bundled). Each map is a
// list of rows, one character per pixel; '.' is transparent. pixelPaths() merges each colour's
// horizontal runs into one SVG path, so a 16x16 ball is a handful of <path> elements.

const BALL_PALETTE = {
  k: '#1c1c21', // outline and band
  R: '#e3350d', // Pokémon red
  r: '#a3200a',
  d: '#74160a',
  h: '#ff7a59',
  H: '#ffffff',
  W: '#f2f2f4',
  w: '#c9c9d1',
  g: '#96969f',
  B: '#ffffff',
  c: '#cfcfd8',
}

// Rows 0-7 lift off when the ball opens; rows 8-15 stay on the ground.
const BALL = [
  '.....kkkkkk.....',
  '...kkRRRRRRkk...',
  '..kRRhhRRRRRRk..',
  '.kRhHhRRRRRRRrk.',
  '.kRhhRRRRRRRRrk.',
  'kRRRRRkkkkRRRrrk',
  'kRRRRkkBBkkRrrdk',
  'kkkkkkBBBckkkkkk',
  'kkkkkkBBcckkkkkk',
  'kWWWWkkcckkWwwgk',
  'kWWWWWkkkkWWwwgk',
  '.kWWWWWWWWWwwgk.',
  '.kWWWWWWWWwwwgk.',
  '..kwWWWWWwwwgk..',
  '...kkwwwwwgkk...',
  '.....kkkkkk.....',
]

export const BALL_LID = { rows: BALL.slice(0, 8), palette: BALL_PALETTE }
export const BALL_BASE = { rows: BALL.slice(8), palette: BALL_PALETTE }

// A few spiky tufts on a 48-pixel strip: one on the path, one at the ball's base, two beyond.
// The ball rests on columns 16-31, so the second tuft hides the bottom of the ball.
export const GRASS = {
  palette: { l: '#8fe07a', G: '#43b04a', g: '#2c7a31' },
  rows: [
    '.....l...l.......l...l...........l..l...........',
    '....lG..lGl.....lG..lGl.........lG.lGl....l.....',
    '....GGl.GGG....lGG.lGGGl........GGlGGG...lGl....',
    '...gGGG.GGGg...GGGlGGGGG.......gGGGGGGg..GGG....',
    '...gGGGgGGGg..gGGGGGGGGGg......gGGGGGGg.gGGGg...',
  ],
}

// The light from the opening ball.
export const BURST = {
  palette: { w: '#fffce8', W: '#ffffff', Y: '#ffe45c' },
  rows: [
    '.......w.......',
    '.......w.......',
    '..w....w....w..',
    '...w...w...w...',
    '....w..W..w....',
    '.....w.W.w.....',
    '......WYW......',
    'wwwwWWYYYWWwwww',
    '......WYW......',
    '.....w.W.w.....',
    '....w..W..w....',
    '...w...w...w...',
    '..w....w....w..',
    '.......w.......',
    '.......w.......',
  ],
}

/** [{ key, fill, d }] for one map: each colour's runs as `M x y h n v1 h-n z` rectangles. */
export function pixelPaths({ rows, palette }) {
  const byColour = new Map()
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const key = row[x]
      if (!palette[key]) {
        x += 1
        continue
      }
      let end = x + 1
      while (end < row.length && row[end] === key) end += 1
      byColour.set(key, `${byColour.get(key) ?? ''}M${x} ${y}h${end - x}v1h-${end - x}z`)
      x = end
    }
  })
  return [...byColour].map(([key, d]) => ({ key, fill: palette[key], d }))
}

export function artSize({ rows }) {
  return { width: Math.max(...rows.map(row => row.length)), height: rows.length }
}
