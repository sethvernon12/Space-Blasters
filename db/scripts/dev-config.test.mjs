import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertDevRef, DEV_REF, PROD_REF } from './dev-config.mjs'

test('assertDevRef accepts the DEV ref', () => {
  assert.equal(assertDevRef(`https://${DEV_REF}.supabase.co`), true)
  assert.equal(assertDevRef(`postgresql://x@db.${DEV_REF}.supabase.co:5432/postgres`), true)
})
test('assertDevRef HARD-REFUSES the prod ref', () => {
  assert.throws(() => assertDevRef(`https://${PROD_REF}.supabase.co`), /REFUSING prod ref/)
})
test('assertDevRef refuses anything that is not DEV (incl. localhost)', () => {
  assert.throws(() => assertDevRef('http://127.0.0.1:54321'), /refusing/)
  assert.throws(() => assertDevRef(''), /refusing/)
  assert.throws(() => assertDevRef('https://someotherref.supabase.co'), /refusing/)
})
