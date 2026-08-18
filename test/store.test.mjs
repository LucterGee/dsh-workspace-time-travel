import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '../lib/store.js'

test('snapshot / diff / restore / undo round trip', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tt-test-'))
  const ws = join(base, 'workspace')
  const storeRoot = join(base, 'store')
  await mkdir(join(ws, 'src'), { recursive: true })
  await mkdir(join(ws, 'node_modules'), { recursive: true })
  await writeFile(join(ws, 'src', 'a.txt'), 'v1')
  await writeFile(join(ws, 'readme.md'), 'r1')
  await writeFile(join(ws, 'node_modules', 'junk.txt'), 'junk')

  const store = new SnapshotStore({ ignore: ['node_modules', '.git'], maxFileBytes: 1024 * 1024 }, storeRoot)

  const first = await store.capture(ws, 'sess-1', 5)
  assert.equal(first.skipped, false)

  // mutate workspace: modify, add, delete
  await writeFile(join(ws, 'src', 'a.txt'), 'v2')
  await writeFile(join(ws, 'src', 'b.txt'), 'new')
  await rm(join(ws, 'readme.md'))

  const second = await store.capture(ws, 'sess-1', 6)
  assert.equal(second.skipped, false)

  // unchanged capture is skipped; lookup falls back to the previous entry
  const third = await store.capture(ws, 'sess-1', 7)
  assert.equal(third.skipped, true)
  const resolved = await store.resolve(ws, ['sess-1'], 7)
  assert.equal(resolved.entry.key, 6)

  // resolve at key 5 returns the first snapshot
  const target = await store.resolve(ws, ['sess-1'], 5)
  assert.equal(target.entry.key, 5)

  // diff against the first snapshot: a.txt restored, readme recreated, b.txt deleted
  const changes = await store.diff(ws, target.entry)
  const ops = Object.fromEntries(changes.map((c) => [c.path, c.op]))
  assert.equal(ops['src/a.txt'], 'restore')
  assert.equal(ops['readme.md'], 'restore')
  assert.equal(ops['src/b.txt'], 'delete')
  assert.equal(changes.length, 3)

  // backup current state, then apply the first snapshot
  const backup = await store.backup(ws, 'sess-1')
  assert.equal(backup.skipped, false)
  const applied = await store.apply(ws, target.entry)
  assert.equal(applied.applied, 3)
  assert.equal(await readFile(join(ws, 'src', 'a.txt'), 'utf8'), 'v1')
  assert.equal(await readFile(join(ws, 'readme.md'), 'utf8'), 'r1')
  await assert.rejects(readFile(join(ws, 'src', 'b.txt')))
  // ignored dirs untouched
  assert.equal(await readFile(join(ws, 'node_modules', 'junk.txt'), 'utf8'), 'junk')

  // undo restores the pre-restore state
  const undone = await store.undo(ws, ['sess-1'])
  assert.equal(undone.found, true)
  assert.equal(await readFile(join(ws, 'src', 'a.txt'), 'utf8'), 'v2')
  assert.equal(await readFile(join(ws, 'src', 'b.txt'), 'utf8'), 'new')
  await assert.rejects(readFile(join(ws, 'readme.md')))

  await rm(base, { recursive: true, force: true })
})
