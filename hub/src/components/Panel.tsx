import { cn } from '@/lib/utils'

// The standard Veritas card: white, 20px radius, thin border, soft shadow.
// Use for EVERY card so geometry stays identical across the app.
export function Panel({
  as: Tag = 'section', className, children, ...rest
}: React.HTMLAttributes<HTMLElement> & { as?: React.ElementType }) {
  return (
    <Tag
      className={cn(
        'rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  )
}
