/**
 * Notes store tests: write/read/append/search/list semantics, path safety,
 * and the bounded checkpoint snapshot.
 *
 * @module tests/notes.spec
 */

import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NotesStore, resolveNotePath } from '../src/notes.ts'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop()
    if (dispose !== undefined) await dispose()
  }
})

/** A store rooted at a fresh temp directory. */
async function tempStore(): Promise<NotesStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rollover-notes-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return new NotesStore(dir)
}

describe('NotesStore', () => {
  it('writes, reads, lists, appends, and searches notes', async () => {
    const store = await tempStore()
    await store.write('state.md', '# goal\nprove rollover')
    await store.write('plans/rollout.md', 'step 1\nstep 2')
    await store.append('state.md', 'decided: no summary')
    await store.append('state.md', 'next: tests')

    expect(await store.read('state.md')).toBe('# goal\nprove rollover\ndecided: no summary\nnext: tests\n')

    const listings = await store.list()
    expect(listings.map(listing => listing.path).sort()).toEqual(['plans/rollout.md', 'state.md'])

    const matches = await store.search('SUMMARY')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ path: 'state.md', line: 3 })
  })

  it('creates the file when append finds nothing to read', async () => {
    const store = await tempStore()
    await store.append('fresh.md', 'first line')
    await store.append('fresh.md', 'second line')
    expect(await store.read('fresh.md')).toBe('first line\nsecond line\n')
  })

  // A note that exists but cannot be read is not an empty note. Append
  // rewrites the whole file from what it read, so mistaking one for the other
  // replaces the note with the appended text and reports success.
  // chmod 0o200 leaves the file writable and unreadable, which is exactly the
  // asymmetry that made the old `catch { current = '' }` destructive.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses to overwrite a note it cannot read',
    async () => {
      const store = await tempStore()
      await store.write('state.md', 'existing\n')
      const absolute = join(store.root, 'state.md')
      const original = await readFile(absolute, 'utf8')
      await chmod(absolute, 0o200)
      try {
        await expect(store.append('state.md', 'appended')).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(absolute, 0o600)
      }
      // The whole point of the fix: the note survives byte for byte.
      expect(await readFile(absolute, 'utf8')).toBe(original)
    },
  )

  it('rejects path traversal and unsafe segments', async () => {
    const store = await tempStore()
    await expect(store.read('../escape.md')).rejects.toThrow(/invalid/)
    await expect(store.write('/absolute.md', 'x')).rejects.toThrow(/invalid/)
    await expect(store.write('a/../b.md', 'x')).rejects.toThrow(/invalid/)
    expect(resolveNotePath(store.root, 'ok.md')).toContain('ok.md')
  })

  it('lists empty when the store directory does not exist', async () => {
    const store = new NotesStore(join(tmpdir(), `dsh-rollover-missing-${Date.now()}`))
    await expect(store.list()).resolves.toEqual([])
  })

  it('renders a bounded snapshot across files', async () => {
    const store = await tempStore()
    await store.write('a.md', 'alpha note')
    await store.write('b.md', 'beta note')
    const snapshot = await store.renderAll(1000)
    expect(snapshot).toContain('### a.md')
    expect(snapshot).toContain('alpha note')
    expect(snapshot).toContain('beta note')

    const bounded = await store.renderAll(10)
    expect(bounded).not.toBeNull()
    expect(bounded?.length).toBeLessThanOrEqual(10 + '### a.md\n'.length)
  })

  it('returns null when there is nothing to render', async () => {
    const store = await tempStore()
    await expect(store.renderAll(1000)).resolves.toBeNull()
  })
})
