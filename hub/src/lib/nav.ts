// The hub's navigation — EXACTLY these seven items, in this order. Math-only.
// No academy pillars. `icon` names map to lucide-react icons at render time.
export interface NavItem {
  to: string
  label: string
  icon: string          // lucide-react icon name
  end?: boolean         // exact-match active state (for the index route)
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Command Center', icon: 'LayoutDashboard', end: true },
  { to: '/practice', label: 'Practice Math', icon: 'Target' },
  { to: '/play', label: 'Play Space Blasters', icon: 'Rocket' },
  { to: '/progress', label: 'My Progress', icon: 'TrendingUp' },
  { to: '/assignments', label: 'Assignments', icon: 'ClipboardList' },
  { to: '/messages', label: 'Messages', icon: 'MessageCircle' },
  { to: '/settings', label: 'Settings', icon: 'Settings' },
]
