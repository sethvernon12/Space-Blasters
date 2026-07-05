import { Greeting } from '@/components/home/Greeting'
import { VerseCard } from '@/components/home/VerseCard'
import { TodaysFocus } from '@/components/home/TodaysFocus'
import { ProgressSummary } from '@/components/home/ProgressSummary'
import { QuickActions } from '@/components/home/QuickActions'
import { AssignmentsPreview } from '@/components/home/AssignmentsPreview'

// The Command Center home. Mostly layout: a responsive grid of six honest
// cards on a near-white background. Single column on mobile; a tasteful
// two-column arrangement at lg where it helps readability.
export default function Home() {
  return (
    <div className="flex flex-col gap-5 py-2 sm:gap-6">
      <Greeting />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <VerseCard />
        <TodaysFocus />
      </div>

      <ProgressSummary />

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2">
        <QuickActions />
        <AssignmentsPreview />
      </div>
    </div>
  )
}
