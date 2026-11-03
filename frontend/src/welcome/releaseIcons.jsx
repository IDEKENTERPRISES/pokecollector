import {
  Award, BookOpen, Bell, Camera, Clock, Download, Flame, LayoutDashboard, Repeat, Smartphone, Star, Target, Trophy, Users, WifiOff,
} from 'lucide-react'

// The circle tints are the artboards': a gradient per icon (docs/WELCOME_DESIGN.md §5.2).
const GREEN = ['#328438', '#145A27']
const BLUE = ['#236BB4', '#123F8C']
const GOLD = ['#836919', '#5A4207']
const ORANGE = ['#B4441F', '#8A1D12']
const PURPLE = ['#8A3BA5', '#551C78']
const SLATE = ['#343F50', '#141A24']

const ICONS = {
  target: [Target, GREEN],
  'layout-dashboard': [LayoutDashboard, GREEN],
  clock: [Clock, BLUE],
  'book-open': [BookOpen, BLUE],
  download: [Download, BLUE],
  'wifi-off': [WifiOff, BLUE],
  users: [Users, BLUE],
  repeat: [Repeat, BLUE],
  star: [Star, GOLD],
  flame: [Flame, ORANGE],
  smartphone: [Smartphone, ORANGE],
  bell: [Bell, ORANGE],
  award: [Award, PURPLE],
  trophy: [Trophy, PURPLE],
  camera: [Camera, SLATE],
}

/** The 40 px circle of a highlight row: a lucide glyph in white on the icon's tint. */
export default function ReleaseIcon({ name }) {
  const [Glyph, [from, to]] = ICONS[name] ?? ICONS.star
  return (
    <span
      aria-hidden="true"
      className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full text-white"
      style={{ background: `linear-gradient(150deg, ${from}, ${to})` }}
    >
      <Glyph size={20} strokeWidth={2} aria-hidden="true" />
    </span>
  )
}
