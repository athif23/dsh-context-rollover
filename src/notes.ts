/**
 * Durable model-managed notes: plain markdown files under one per-session
 * directory, surviving context rollovers within the session. Notes are the
 * model's own selected state — nothing is written automatically.
 *
 * A file store (not session events) keeps every log readable by any DSH
 * build: `Session.append` cannot mark a plugin's custom event types
 * `ignorable`, so unknown plugin events on a session log would make that log
 * refused at restore.
 *
 * @module dsh-context-rollover/notes
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Reject path traversal and unsafe note path components. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/

/**
 * Validate a model-supplied note path and map it into the store directory.
 * @param dir - the store's root directory.
 * @param path - relative note path (`foo.md`, `plans/rollout.md`).
 * @returns the absolute file path.
 * @throws when the path escapes the store (traversal, absolute, empty segments).
 */
export function resolveNotePath(dir: string, path: string): string {
  if (path.length === 0) throw new Error('note path must not be empty')
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)) {
      throw new Error(
        `note path "${path}" is invalid: segments must be relative and match ${SAFE_SEGMENT.source}`,
      )
    }
  }
  return join(dir, ...segments)
}

/** One listed note file. */
export interface NoteListing {
  /** Store-relative path. */
  readonly path: string
  readonly size: number
  readonly updatedAt: number
}

/** One literal note search hit. */
export interface NoteMatch {
  readonly path: string
  /** 1-based line number. */
  readonly line: number
  /** The matched line text. */
  readonly text: string
}

/** Per-session durable notes store over plain markdown files. */
export class NotesStore {
  constructor(private readonly dir: string) {}

  /** The store's root directory. */
  get root(): string {
    return this.dir
  }

  /**
   * Resolve the default store directory for one session: `<notesDir>/<id>`
   * under the configured base, defaulting to `<dsh home>/notes/<id>`.
   * @param sessionId - the owning session's id.
   * @param baseDir - configured base directory override, when any.
   * @returns the store directory.
   */
  static directoryFor(sessionId: string, baseDir?: string): string {
    return join(baseDir ?? dshHomePath('notes'), sessionId)
  }

  /**
   * List note files newest-modified first.
   * @returns the listings, or `[]` when the store directory does not exist.
   */
  async list(): Promise<NoteListing[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir, { recursive: true })
    } catch {
      return []
    }
    const listings = await Promise.all(entries.map(async (entry) => {
      const path = entry.replaceAll('\\', '/')
      const absolute = join(this.dir, entry)
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined || !info.isFile()) return undefined
      return { path, size: info.size, updatedAt: info.mtimeMs }
    }))
    return listings
      .filter((listing): listing is NoteListing => listing !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Read one note file's full text.
   * @param path - store-relative note path.
   * @returns the file text.
   */
  async read(path: string): Promise<string> {
    return readFile(resolveNotePath(this.dir, path), 'utf8')
  }

  /**
   * Create or replace one note file, creating parent directories.
   * @param path - store-relative note path.
   * @param text - complete replacement text.
   */
  async write(path: string, text: string): Promise<void> {
    const absolute = resolveNotePath(this.dir, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, text, 'utf8')
  }

  /**
   * Append text to one note file, creating it when missing. Appends always
   * end with a newline so successive appends stay line-oriented.
   * @param path - store-relative note path.
   * @param text - text to append exactly as provided.
   */
  async append(path: string, text: string): Promise<void> {
    const absolute = resolveNotePath(this.dir, path)
    let current: string
    try {
      current = await readFile(absolute, 'utf8')
    } catch {
      current = ''
    }
    const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, `${current}${separator}${text}\n`, 'utf8')
  }

  /**
   * Literal case-insensitive search over note lines.
   * @param query - literal substring to find.
   * @param maxMatches - upper bound on returned matches.
   * @returns the matches in file order.
   */
  async search(query: string, maxMatches = 20): Promise<NoteMatch[]> {
    const lowerQuery = query.toLowerCase()
    if (lowerQuery.length === 0) return []
    const matches: NoteMatch[] = []
    for (const listing of await this.list()) {
      if (matches.length >= maxMatches) break
      let text: string
      try {
        text = await this.read(listing.path)
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line === undefined || !line.toLowerCase().includes(lowerQuery)) continue
        matches.push({ path: listing.path, line: index + 1, text: line })
        if (matches.length >= maxMatches) break
      }
    }
    return matches
  }

  /**
   * Render every note file into one bounded text snapshot for a rollover
   * checkpoint. `maxChars` bounds the whole snapshot (headers included);
   * note bodies are filled newest-modified first.
   * @param maxChars - hard character bound for the snapshot.
   * @returns the snapshot, or `null` when the store is empty.
   */
  async renderAll(maxChars: number): Promise<string | null> {
    const listings = await this.list()
    if (listings.length === 0) return null
    const sections: string[] = []
    let length = 0
    for (const listing of listings) {
      let text: string
      try {
        text = await this.read(listing.path)
      } catch {
        continue
      }
      const header = `### ${listing.path}\n`
      const remaining = maxChars - length - header.length
      if (remaining <= 0) break
      const body = text.length > remaining ? text.slice(0, remaining) : text
      length += header.length + body.length
      sections.push(`${header}${body}`)
    }
    if (sections.length === 0) return null
    return sections.join('\n\n')
  }
}
