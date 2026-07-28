/**
 * Project file format.
 *
 * Only the edit is stored — clip order, trims, layouts, captions — never the
 * footage. A project file is therefore tiny, and the sources stay wherever the
 * user keeps them. The cost is that a project breaks if its footage is moved,
 * which loading reports per clip rather than failing outright.
 */
import type { AspectPreset, CaptionStyle, Clip } from './types'

/** Bumped when the shape changes in a way older files cannot satisfy. */
export const PROJECT_VERSION = 1

export const PROJECT_EXT = 'flowclip'

export interface ProjectFile {
  version: number
  app: string
  savedAt: string
  aspect: AspectPreset
  captionStyle: CaptionStyle
  clips: Clip[]
}

export function serialiseProject(
  clips: Clip[],
  aspect: AspectPreset,
  captionStyle: CaptionStyle
): ProjectFile {
  return {
    version: PROJECT_VERSION,
    app: 'FlowClip',
    savedAt: new Date().toISOString(),
    aspect,
    captionStyle,
    clips
  }
}

export interface LoadedProject {
  project: ProjectFile
  /** Source files the project refers to that are no longer on disk. */
  missing: string[]
}

/**
 * Validates a parsed project file.
 *
 * Rejects anything that is not recognisably a FlowClip project, and refuses a
 * newer version rather than loading it partially and silently dropping whatever
 * the older code does not understand.
 */
export function validateProject(data: unknown): ProjectFile {
  if (!data || typeof data !== 'object') throw new Error('Not a FlowClip project file')
  const p = data as Partial<ProjectFile>

  if (p.app !== 'FlowClip' || typeof p.version !== 'number') {
    throw new Error('Not a FlowClip project file')
  }
  if (p.version > PROJECT_VERSION) {
    throw new Error(
      `This project was saved by a newer version of FlowClip (v${p.version}). Update to open it.`
    )
  }
  if (!Array.isArray(p.clips)) throw new Error('Project file has no clips')

  return {
    version: p.version,
    app: 'FlowClip',
    savedAt: typeof p.savedAt === 'string' ? p.savedAt : '',
    aspect: (p.aspect ?? 'vertical') as AspectPreset,
    captionStyle: p.captionStyle as CaptionStyle,
    clips: p.clips as Clip[]
  }
}
