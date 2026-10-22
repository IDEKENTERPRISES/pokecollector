// The splash's 16-bit pixel art and pixel font, drawn for this app (no game sprites or fonts are
// bundled). Each map is a list of rows, one character per pixel; '.' is transparent. pixelPaths()
// merges each colour's horizontal runs into one SVG path. A palette value of 'currentColor' takes
// the element's CSS colour (the light in the Pokémon's type colour).

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

// The ground under the ball: one for each of the 18 types, by the Pokémon's first type. Every
// strip is 48 x 5 and the ball rests on columns 16-31, so decorations that would sit in front of
// it stay to the sides. `lift` raises the ball and the Pokémon (in art pixels) onto flat floors,
// so they stand on the surface instead of sinking into it.
const GRASS_PALETTE = { l: '#8fe07a', G: '#43b04a', g: '#2c7a31' }
const GRASS_ROWS = [
  '.....l...l.......l...l...........l..l...........',
  '....lG..lGl.....lG..lGl.........lG.lGl....l.....',
  '....GGl.GGG....lGG.lGGGl........GGlGGG...lGl....',
  '...gGGG.GGGg...GGGlGGGGG.......gGGGGGGg..GGG....',
  '...gGGGgGGGg..gGGGGGGGGGg......gGGGGGGg.gGGGg...',
]
const EMPTY = '................................................'
const repeat = pattern => pattern.repeat(Math.ceil(48 / pattern.length)).slice(0, 48)

export const GROUNDS = {
  // A lawn edge over a dirt path.
  normal: {
    palette: { l: '#8fe07a', G: '#5fae4f', d: '#c9a46b', D: '#a07a45', p: '#8c7a62' },
    rows: [
      EMPTY,
      EMPTY,
      '..l.......l....l.......l.....l.......l....l.....',
      repeat('G'),
      'dddDdddddddpddddDddddddddddDdddpdddddDdddddddDdd',
    ],
  },
  grass: { palette: GRASS_PALETTE, rows: GRASS_ROWS },
  // Tall grass, where wild Pokémon hide.
  bug: {
    palette: { l: '#9ee07a', G: '#3f9f3c', g: '#246b2c' },
    rows: [
      repeat('.l....l...l.....l..'),
      repeat('lGl..lGl.lGl...lGl.'),
      repeat('GGGllGGGlGGGl.lGGGl'),
      repeat('gGGGGgGGGGgGGGGGgGG'),
      repeat('ggGggggGggggGgggggG'),
    ],
  },
  electric: {
    palette: { ...GRASS_PALETTE, y: '#f7c815' },
    rows: [
      '.....l...l...y...l...l...........l..l...........',
      '....lG..lGl.y...lG..lGl.....y...lG.lGl....l..y..',
      '....GGl.GGG....lGG.lGGGl...y....GGlGGG...lGl..y.',
      GRASS_ROWS[3],
      GRASS_ROWS[4],
    ],
  },
  // Ripples.
  water: {
    palette: { w: '#e8f6ff', L: '#7cc4ff', B: '#2f8ff0', D: '#1b5fae' },
    rows: [
      EMPTY,
      '..ww.........ww..........ww..........ww.........',
      '.wLLw.......wLLw........wLLw........wLLw........',
      'LLBBLLLLLLLLLBBLLLLLLLLLLBBLLLLLLLLLLBBLLLLLLLLL',
      'BBDDBBBBBBBBBDDBBBBBBBBBBDDBBBBBBBBBBDDBBBBBBBBB',
    ],
  },
  // Snow drifts on a frozen floor, with glints.
  ice: {
    palette: { g: '#ffffff', W: '#f4fbff', w: '#d6ecfa', I: '#a8e2f7', i: '#7cc8ea', b: '#4f9fd0' },
    rows: [
      '....g................................g..........',
      '...gWg.......................g......gWg.....g...',
      '..WWwWW.........WWWW........gWg....WWwWW...WWW..',
      repeat('IIIIIiIIIIIIIIIIiIIIIIIIIIIIIIiIIIIIIIIIIIi'),
      repeat('iiibiiiiiiiibiiiiiiiiiiiibiiiiiiiiiib'),
    ],
  },
  // Embers and small flames on volcanic rock.
  fire: {
    palette: { y: '#ffe066', o: '#ff8a2b', r: '#e3350d', R: '#5a4038', v: '#3a2a26', l: '#ff6a2b', L: '#ffd23f' },
    rows: [
      '......y....o...........................y..y.....',
      '..y..yoy...........................o..yoy.......',
      '.....ror..............................ror.......',
      repeat('R'),
      'vvvlvvvvvvvvLlvvvvvvvvvvvlvvvvvvvvvLlvvvvvvvvvlv',
    ],
  },
  // Sand.
  ground: {
    palette: { S: '#f0d391', s: '#d8b56a', D: '#a7843f', p: '#8c7a62' },
    rows: [
      EMPTY,
      '.................SSSS...........................',
      '.....SSS.......SSsSSSSS..........SSS............',
      '...SSsSSSS....SsssSsssSS....p...SsSSS....p......',
      '..SsssssspS..SsssssssssDs..pD..SsssssS..SsS.....',
    ],
  },
  // Boulders.
  rock: {
    palette: { L: '#c2b8ab', M: '#958a7d', D: '#615850', s: '#7d7368' },
    rows: [
      EMPTY,
      '.....LLL.........LLLL...........................',
      '....LLMMM......LLLMMMMM..........LL.....LLM.....',
      '...LMMMMDD....LLMMMMMMDD.....s..LMMD...LMMMD....',
      '...MMDDDDDs...MMMDDDMDDD.....Ls.MDDD...MMDDD....',
    ],
  },
  // A wooden dojo floor, planks edge-on.
  fighting: {
    lift: 1,
    palette: { W: '#e8b77a', w: '#c98f52', b: '#7a4a24' },
    rows: [EMPTY, EMPTY, repeat('W'), repeat('wwwwwwwwwwwbwwwwwwwwwwwwbwwwwwwwwwwwwb'), repeat('b')],
  },
  // Purple crystal tiles, a few crystals growing out of them.
  psychic: {
    lift: 1,
    palette: { s: '#f5d6ff', P: '#c77ce8', p: '#8a3ba5', d: '#4e1f66' },
    rows: [
      '....s......s..........................s.....s...',
      '...sPs....sPs........................sPs...sPs..',
      repeat('PPPPPPPd'),
      repeat('pppPpppdpppppPpd'),
      repeat('d'),
    ],
  },
  // Pink flowers.
  fairy: {
    palette: { ...GRASS_PALETTE, p: '#ef6fae', P: '#ffd1e6', y: '#ffe066' },
    rows: [
      '....p...l.......P...p............p.......P......',
      '...pyp..Gl.....PyP.pyp..........pyp.l...PyP.....',
      '....p..lGG......PG..p.lG.........pGlG....Pl.....',
      '....Gl.GGGg....lGG.lGGGGl.......lGGGGg...GG.....',
      '...gGGgGGGg...gGGGgGGGGGg......gGGGGGg..gGGg....',
    ],
  },
  // Dark soil with wisps floating over it.
  ghost: {
    palette: { w: '#e6dbff', W: '#9f86e0', S: '#5a4a62', s: '#3a2f40' },
    rows: [
      '....w......w.........................w......w...',
      '...wWw....wWw.......................wWw....wWw..',
      '....W......W.........................W......W...',
      repeat('SSSSSsSSSSSSSSSSsSSSSSSSsSSSS'),
      repeat('s'),
    ],
  },
  // Black cobbles.
  dark: {
    lift: 1,
    palette: { C: '#84849a', c: '#5a5a70', k: '#2a2a36' },
    rows: [EMPTY, EMPTY, repeat('kCCCCkCCCkCCCCC'), repeat('cccckccccckccck'), repeat('k')],
  },
  // A rocky ledge with a gold vein, ending in a drop on the right.
  dragon: {
    lift: 1,
    palette: { m: '#6aa84f', T: '#a89a80', t: '#7d705a', v: '#c9a227', d: '#4f4636' },
    rows: [
      EMPTY,
      '...m.........m.............................m....',
      'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT..',
      'tttvtttttttttttttttvvttttttttttttttvttttttttt...',
      'dddddddvdddddddddddddddddddddddddddddddddddd....',
    ],
  },
  // Riveted plates.
  steel: {
    lift: 1,
    palette: { S: '#d2dbe3', s: '#94a2b0', d: '#5e6a76', r: '#ffffff' },
    rows: [EMPTY, EMPTY, repeat('SSSSSSSSSSSd'), repeat('srsssssssrsd'), repeat('d')],
  },
  // A purple bog with bubbles.
  poison: {
    palette: { u: '#e0b0ff', B: '#9a5cc4', b: '#6a3f8c', d: '#3f2457' },
    rows: [
      '.....u....u..........................u.......u..',
      '....u....uBu........................uBu.....u...',
      '...uBu.....................................uBu..',
      repeat('BBbBBBBBBbBBBBBBBBBbBBBBBBb'),
      repeat('bbbbbdbbbbbbbbbdbbbbbbbbbb'),
    ],
  },
  // A cloud bank.
  flying: {
    palette: { W: '#ffffff', w: '#e3ecf7', s: '#b8c7dc' },
    rows: [
      '................WWWWW...........................',
      '....WWW.......WWWWWWWWWW........WWW.............',
      '..WWWWWWW....WWWwwWWWWWWW......WWWWWW....WW.....',
      '.WWwwWWWWW..WwwssswwwWWwwW....WwwWWwwW..WWWW....',
      '.wwsswwwww..wsssssssswwssw....sssswwss..wsswW...',
    ],
  },
}

/** The ground's name for a Pokémon's types: its first type, or grass when unknown. */
export function groundName(types) {
  const type = String(types?.[0] ?? '').toLowerCase()
  return Object.hasOwn(GROUNDS, type) ? type : 'grass'
}

export function groundFor(types) {
  return GROUNDS[groundName(types)]
}

// The light from the opening ball: rays in the type's colour around a white core.
export const BURST = {
  palette: { w: 'currentColor', W: '#ffffff', Y: '#ffffff' },
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

// The shiny sparkle.
export const SPARKLE = {
  palette: { y: '#fff3b0', Y: '#ffd94a', W: '#ffffff' },
  rows: [
    '...y...',
    '...Y...',
    '..yYy..',
    'yYYWYYy',
    '..yYy..',
    '...Y...',
    '...y...',
  ],
}

// A 5 x 8 pixel font for the "Wild … appeared!" box: each glyph is eight base-32 digits, one per
// row, the highest bit on the left; the last row is the descender. It covers every Pokémon name
// in capitals (en and de) and the box's sentences.
const GLYPHS = {
  0: 'ehjlphe0', 1: '4c4444e0', 2: 'eh1248v0', 3: 'v2421he0', 4: '26aiv220', 5: 'vgu11he0', 6: '68guhhe0',
  7: 'v1248880', 8: 'ehhehhe0', 9: 'ehhf12c0', A: 'ehhvhhh0', B: 'uhhuhhu0', C: 'ehggghe0', D: 'uhhhhhu0',
  E: 'vgguggv0', F: 'vgguggg0', G: 'ehgnhhf0', H: 'hhhvhhh0', I: 'e44444e0', J: '72222ic0', K: 'hikokih0',
  L: 'ggggggv0', M: 'hrllhhh0', N: 'hhpljhh0', O: 'ehhhhhe0', P: 'uhhuggg0', Q: 'ehhhlid0', R: 'uhhukih0',
  S: 'fgge11u0', T: 'v4444440', U: 'hhhhhhe0', V: 'hhhhha40', W: 'hhhllla0', X: 'hha4ahh0', Y: 'hha44440',
  Z: 'v1248gv0', 'Ä': 'a0ehvhh0', 'Ö': 'a0ehhhe0', 'Ü': 'a0hhhhe0', 'É': '24vgugv0',
  a: '00e1fhf0', c: '00egghe0', d: '11djhhf0', e: '00ehvge0', h: 'ggmphhh0', i: '40c444e0', l: 'c44444e0',
  n: '00mphhh0', p: '00uhhugg', r: '00mpggg0', s: '00ege1u0', t: '88s88960', w: '00hhlla0', '!': '44444040',
  "'": '44800000', '’': '44800000', '.': '00000cc0', '-': '000e0000', ':': '0cc0cc00',
  '♀': 'ehhe4e40', '♂': '71diic00',
}
export const GLYPH_ADVANCE = 6
export const GLYPH_HEIGHT = 8

/** The pixel art for a line of text in the font (unknown characters become spaces). */
export function textArt(text) {
  const chars = [...String(text)]
  const width = Math.max(1, chars.length * GLYPH_ADVANCE - 1)
  const rows = Array.from({ length: GLYPH_HEIGHT }, () => Array(width).fill('.'))
  chars.forEach((char, index) => {
    const glyph = GLYPHS[char]
    if (!glyph) return
    for (let y = 0; y < GLYPH_HEIGHT; y += 1) {
      const bits = parseInt(glyph[y], 32)
      for (let x = 0; x < 5; x += 1) {
        if (bits & (16 >> x)) rows[y][index * GLYPH_ADVANCE + x] = 't'
      }
    }
  })
  return { rows: rows.map(row => row.join('')), palette: { t: 'currentColor' } }
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
