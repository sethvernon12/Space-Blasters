import { useEffect, useState } from 'react'
import { Panel } from '@/components/Panel'
import { Icon } from '@/components/Icon'
import { listChildFeedback, type ChildFeedbackNote } from '@/lib/api'

// Phase 5 · 5d — the child's own feedback view. It shows ONLY the human-moderated
// `sent-to-child` note created when an adult CONFIRMS a grade — never a raw or unconfirmed
// AI proposal (RLS 0006 excludes 'private' scopes for the child; 0031 excludes the child from
// grade_proposals). SAF: nothing reaches the child until a human confirms, and then only the
// note the human chose. Rendered as escaped React text — moderate_text is a link/PII filter,
// not an HTML sanitizer, so the VIEW does the escaping; never dangerouslySetInnerHTML.
export function ChildFeedback({ childId }: { childId: string }) {
  const [notes, setNotes] = useState<ChildFeedbackNote[]>([])
  useEffect(() => { void listChildFeedback(childId).then(setNotes) }, [childId])
  if (notes.length === 0) return null
  return (
    <Panel data-testid="child-feedback">
      <h2 className="text-base font-bold text-foreground">Notes on my work 💬</h2>
      <ul className="mt-2 flex flex-col gap-2">
        {notes.map((n) => (
          <li key={n.id} className="flex items-start gap-2 rounded-xl bg-surface-muted px-3 py-2">
            <span className="mt-0.5 shrink-0" style={{ color: 'var(--accent-purple)' }}><Icon name="MessageCircle" size={16} /></span>
            <p data-testid="feedback-note" className="text-sm text-foreground">{n.feedback}</p>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
