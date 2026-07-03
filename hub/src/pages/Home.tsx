import { Tile } from '../components/Tile'
import { GAME_URL } from '../lib/config'
import { useAuth } from '../lib/auth'

export default function Home() {
  const { account } = useAuth()

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold text-[#dfe9ff] sm:text-3xl">
          Ready to fly, {account?.name ?? 'pilot'}?
        </h1>
        <p className="mt-1 text-sm text-hud">Pick your next mission.</p>
      </header>

      <div className="mt-6">
        <Tile
          big
          accent="primary"
          icon="🚀"
          title="Play Space Blasters"
          description="Blast math problems — say the answer!"
          href={GAME_URL}
          ariaLabel="Play Space Blasters — opens the game"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Tile
          accent="cyan"
          icon="⭐"
          title="My Progress"
          description="Your 23 skills, ready to light up."
          to="/progress"
          ariaLabel="My Progress"
        />
        <Tile
          accent="gold"
          icon="📋"
          title="My Assignments"
          description="Work your parent sets for you."
          to="/assignments"
          badge="Coming soon"
          ariaLabel="My Assignments — coming soon"
        />
        <Tile
          accent="mint"
          icon="✏️"
          title="Practice Math"
          description="Quick practice outside the game."
          to="/practice"
          badge="Coming soon"
          ariaLabel="Practice Math — coming soon"
        />
      </div>
    </div>
  )
}
