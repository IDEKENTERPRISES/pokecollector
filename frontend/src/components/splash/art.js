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

// The ground under the ball matches the Pokémon's type. Every strip is 48 x 5 and the ball rests
// on columns 16-31, so the second clump hides the bottom of the ball.
const GRASS_PALETTE = { l: '#8fe07a', G: '#43b04a', g: '#2c7a31' }
const GRASS_ROWS = [
  '.....l...l.......l...l...........l..l...........',
  '....lG..lGl.....lG..lGl.........lG.lGl....l.....',
  '....GGl.GGG....lGG.lGGGl........GGlGGG...lGl....',
  '...gGGG.GGGg...GGGlGGGGG.......gGGGGGGg..GGG....',
  '...gGGGgGGGg..gGGGGGGGGGg......gGGGGGGg.gGGGg...',
]

export const GROUNDS = {
  grass: { palette: GRASS_PALETTE, rows: GRASS_ROWS },
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
  sand: {
    palette: { S: '#f0d391', s: '#d8b56a', D: '#a7843f', p: '#8c7a62' },
    rows: [
      '................................................',
      '.................SSSS...........................',
      '.....SSS.......SSsSSSSS..........SSS............',
      '...SSsSSSS....SsssSsssSS....p...SsSSS....p......',
      '..SsssssspS..SsssssssssDs..pD..SsssssS..SsS.....',
    ],
  },
  water: {
    palette: { w: '#e8f6ff', L: '#7cc4ff', B: '#2f8ff0', D: '#1b5fae' },
    rows: [
      '................................................',
      '..ww.........ww..........ww..........ww.........',
      '.wLLw.......wLLw........wLLw........wLLw........',
      'LLBBLLLLLLLLLBBLLLLLLLLLLBBLLLLLLLLLLBBLLLLLLLLL',
      'BBDDBBBBBBBBBDDBBBBBBBBBBDDBBBBBBBBBBDDBBBBBBBBB',
    ],
  },
  snow: {
    palette: { W: '#ffffff', w: '#dfeefe', b: '#a9c8ea', g: '#9fe8ff' },
    rows: [
      '................................................',
      '.................WWWW...........................',
      '.....WWW.......WWwWWWWW..........WWW............',
      '...WWwWWWW....WwbbWwwwWW........WwWWW....W......',
      '..WwbbwwgwW..Wwbbbbwwbbwg......WbbwwgW..WbW.....',
    ],
  },
  rock: {
    palette: { L: '#c2b8ab', M: '#958a7d', D: '#615850', s: '#7d7368' },
    rows: [
      '................................................',
      '.....LLL.........LLLL...........................',
      '....LLMMM......LLLMMMMM..........LL.....LLM.....',
      '...LMMMMDD....LLMMMMMMDD.....s..LMMD...LMMMD....',
      '...MMDDDDDs...MMMDDDMDDD.....Ls.MDDD...MMDDD....',
    ],
  },
  fire: {
    palette: { y: '#ffe066', o: '#ff8a2b', r: '#e3350d', d: '#5c2a1a' },
    rows: [
      '..................y.............................',
      '.....y...........yoy......................y.....',
      '....yoy...y.....yooy........y.....y......yoy....',
      '....ror..yoy....roorr......yoy...yoy.....ror....',
      'dddrrorrdorodddrrorrrrddddroorrddorordddrrorrddd',
    ],
  },
  cave: {
    palette: { L: '#b48cff', M: '#7a52c7', D: '#3d2a66' },
    rows: [
      '..................L.............................',
      '.................LMD.....................L......',
      '.....L..........LMMD.L..........L.......LMD.....',
      '....LMD.L......LMMMDLMD........LMD.....LMMD.....',
      'DDDLMMDDMDDDDDLMMMMDMMDDDDDDDDDMMDDDDDLMMMDDDDDD',
    ],
  },
  clouds: {
    palette: { W: '#ffffff', w: '#e3ecf7', s: '#b8c7dc' },
    rows: [
      '................WWWWW...........................',
      '....WWW.......WWWWWWWWWW........WWW.............',
      '..WWWWWWW....WWWwwWWWWWWW......WWWWWW....WW.....',
      '.WWwwWWWWW..WwwssswwwWWwwW....WwwWWwwW..WWWW....',
      '.wwsswwwww..wsssssssswwssw....sssswwss..wsswW...',
    ],
  },
  flowers: {
    palette: { ...GRASS_PALETTE, p: '#ef6fae', P: '#ffd1e6', y: '#ffe066' },
    rows: [
      '....p...l.......P...p............p.......P......',
      '...pyp..Gl.....PyP.pyp..........pyp.l...PyP.....',
      '....p..lGG......PG..p.lG.........pGlG....Pl.....',
      '....Gl.GGGg....lGG.lGGGGl.......lGGGGg...GG.....',
      '...gGGgGGGg...gGGGgGGGGGg......gGGGGGg..gGGg....',
    ],
  },
}

// The 18 game types on the grounds above (by the Pokémon's first type).
export const GROUND_FOR_TYPE = {
  grass: 'grass', bug: 'grass', normal: 'grass',
  electric: 'electric',
  ground: 'sand',
  water: 'water',
  ice: 'snow',
  rock: 'rock', fighting: 'rock', steel: 'rock',
  fire: 'fire',
  dark: 'cave', ghost: 'cave', poison: 'cave',
  flying: 'clouds', dragon: 'clouds',
  fairy: 'flowers', psychic: 'flowers',
}

export function groundFor(types) {
  return GROUNDS[GROUND_FOR_TYPE[String(types?.[0] ?? '').toLowerCase()]] ?? GROUNDS.grass
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
