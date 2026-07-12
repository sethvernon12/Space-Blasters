import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Icon } from '@/components/Icon'
import { getUploadUrl, listUploads, uploadWork, type Upload } from '@/lib/api'
import { blobToBase64, prepareImage } from '@/lib/imagePrep'

const STATUS_LABEL: Record<string, string> = { inbox: 'New', in_progress: 'In progress', graded: 'Graded', filed: 'Filed' }

// A child's homework-photo inbox: a camera-first "Add work" affordance + the filed
// items. Per the RECIPE-BOX rule, the upload to-do ships with its complete kit (what to
// shoot, format, size, and the privacy promise) right on the control — never a bare
// button. EXIF/geo is stripped on-device (imagePrep) then re-stripped server-side.
export function ChildInbox({ childId, childName }: { childId: string; childName: string }) {
  const [items, setItems] = useState<Upload[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const ups = await listUploads(childId)
    setItems(ups)
    for (const u of ups) {
      const url = await getUploadUrl(u.id)
      if (url) setThumbs((t) => ({ ...t, [u.id]: url }))
    }
  }, [childId])
  useEffect(() => { void load() }, [load])

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''   // allow re-picking the same file
    if (!file) return
    setBusy(true); setErr(null)
    try {
      const prepared = await prepareImage(file)          // HEIC decode + EXIF strip + downscale (on device)
      const b64 = await blobToBase64(prepared.blob)
      const res = await uploadWork(childId, b64, null)
      if (!res.ok) { setErr(res.error ?? 'Upload failed.'); return }
      await load()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not process that image.')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">Inbox</span>
        <button type="button" data-testid="upload-work" disabled={busy} onClick={() => fileRef.current?.click()}
          className="flex min-h-9 items-center gap-1.5 rounded-full bg-primary px-3 text-sm font-bold text-primary-foreground disabled:opacity-60">
          <Icon name="Camera" size={15} /> {busy ? 'Uploading…' : 'Add work'}
        </button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/heic,image/heif,image/*" capture="environment" onChange={onPick} className="hidden" aria-label={`Photograph ${childName}'s work`} />
      </div>
      {/* recipe-box: the to-do ships with its kit */}
      <p className="text-xs text-muted-foreground">Photograph one page of {childName}’s work — good light, laid flat, filling the frame. JPEG, PNG, or HEIC up to 10&nbsp;MB. Location data is removed automatically before it’s sent.</p>
      {err && <p role="alert" data-testid="upload-error" className="text-xs font-medium text-[color:var(--danger)]">{err}</p>}
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No work in the inbox yet.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2" data-testid="inbox-items">
          {items.map((u) => (
            <li key={u.id} className="overflow-hidden rounded-xl border border-border">
              {thumbs[u.id]
                ? <img src={thumbs[u.id]} alt={`${childName}'s uploaded work`} className="aspect-square w-full object-cover" />
                : <div className="grid aspect-square w-full place-items-center bg-surface-muted text-muted-foreground"><Icon name="Image" size={20} /></div>}
              <span className="block px-1.5 py-1 text-[10px] font-medium text-muted-foreground">{STATUS_LABEL[u.status] ?? u.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
