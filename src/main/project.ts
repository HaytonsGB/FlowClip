/**
 * Reading and writing project files, plus the autosave used for recovery.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { validateProject, type ProjectFile, type LoadedProject } from '../shared/project'

function autosavePath(): string {
  const dir = join(app.getPath('userData'), 'recovery')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'autosave.flowclip')
}

export function saveProject(filePath: string, project: ProjectFile): void {
  writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf8')
}

/**
 * Loads a project and reports which source files have gone missing, rather than
 * refusing the whole project because one clip moved.
 */
export function loadProject(filePath: string): LoadedProject {
  const raw = readFileSync(filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('That file is not valid JSON — it may be damaged.')
  }

  const project = validateProject(parsed)
  const missing = project.clips
    .map((c) => c.meta?.path)
    .filter((p): p is string => typeof p === 'string' && !existsSync(p))

  return { project, missing }
}

export function writeAutosave(project: ProjectFile): void {
  try {
    writeFileSync(autosavePath(), JSON.stringify(project), 'utf8')
  } catch {
    // Recovery is best effort; never let it interrupt editing.
  }
}

/** The autosave, if one exists and still has clips worth restoring. */
export function readAutosave(): { project: ProjectFile; savedAt: string } | null {
  const p = autosavePath()
  if (!existsSync(p)) return null
  try {
    const project = validateProject(JSON.parse(readFileSync(p, 'utf8')))
    if (!project.clips.length) return null
    return { project, savedAt: statSync(p).mtime.toISOString() }
  } catch {
    return null
  }
}

export function clearAutosave(): void {
  rmSync(autosavePath(), { force: true })
}
