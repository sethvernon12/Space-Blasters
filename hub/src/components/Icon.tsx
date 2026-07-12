// One place to map icon names -> lucide-react components, so every lane renders
// the same icon set consistently. Icons are decorative by default (aria-hidden);
// pass a `label` to expose one to assistive tech.
import {
  LayoutDashboard, Target, Rocket, TrendingUp, ClipboardList, MessageCircle,
  Settings, Plus, Minus, CircleDot, X, Divide, HelpCircle, Flame, BookOpen,
  Volume2, ArrowRight, ArrowLeft, Menu, Sparkles, ExternalLink, Check, LogOut,
  GraduationCap, Star, PencilLine, Gamepad2,
  Users, ChevronRight, ChevronLeft, ChevronDown, Heart, Repeat, Loader,
  Trash2, CheckCircle2, UserRound, Camera, Image as ImageIcon, type LucideProps,
} from 'lucide-react'

const MAP = {
  LayoutDashboard, Target, Rocket, TrendingUp, ClipboardList, MessageCircle,
  Settings, plus: Plus, minus: Minus, 'circle-dot': CircleDot, x: X,
  divide: Divide, 'help-circle': HelpCircle, Flame, BookOpen, Volume2,
  ArrowRight, ArrowLeft, Menu, Sparkles, ExternalLink, Check, LogOut,
  GraduationCap, Star, PencilLine, Gamepad2,
  Users, ChevronRight, ChevronLeft, ChevronDown, Heart, Repeat, Loader,
  Trash2, CheckCircle2, UserRound, Camera, Image: ImageIcon,
} as const

export type IconName = keyof typeof MAP

// `name` accepts a known IconName (with autocomplete) or any string (dynamic
// icon fields); an unknown name renders nothing.
export function Icon({ name, label, ...props }: { name: IconName | (string & {}); label?: string } & LucideProps) {
  const C = MAP[name as IconName]
  if (!C) return null
  return <C aria-hidden={label ? undefined : true} aria-label={label} {...props} />
}
