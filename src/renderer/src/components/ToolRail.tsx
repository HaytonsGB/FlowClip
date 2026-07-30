import {
  ScissorsIcon,
  LayersIcon,
  CaptionsIcon,
  MusicIcon,
  AdjustIcon,
  TextIcon,
  StickerIcon,
  EffectsIcon
} from './Icons'

export type ToolId =
  | 'trim'
  | 'layout'
  | 'captions'
  | 'audio'
  | 'adjust'
  | 'text'
  | 'stickers'
  | 'effects'

export interface Tool {
  id: ToolId
  label: string
  icon: (p: { size?: number }) => JSX.Element
  /** Milestone that delivers it; undefined means it already works. */
  milestone?: string
}

export const TOOLS: Tool[] = [
  { id: 'trim', label: 'Trim', icon: ScissorsIcon },
  { id: 'layout', label: 'Layout', icon: LayersIcon },
  { id: 'captions', label: 'Captions', icon: CaptionsIcon },
  { id: 'audio', label: 'Music', icon: MusicIcon },
  { id: 'adjust', label: 'Adjust', icon: AdjustIcon },
  { id: 'text', label: 'Text', icon: TextIcon },
  { id: 'stickers', label: 'Stickers', icon: StickerIcon, milestone: 'M4' },
  { id: 'effects', label: 'Effects', icon: EffectsIcon, milestone: 'M5' }
]

interface Props {
  active: ToolId
  onSelect: (id: ToolId) => void
  disabled: boolean
}

export function ToolRail({ active, onSelect, disabled }: Props): JSX.Element {
  return (
    <nav className="rail" aria-label="Tools">
      {TOOLS.map((tool) => {
        const Icon = tool.icon
        return (
          <button
            key={tool.id}
            className={`rail-item ${active === tool.id ? 'active' : ''}`}
            onClick={() => onSelect(tool.id)}
            disabled={disabled}
            aria-current={active === tool.id}
            title={tool.milestone ? `${tool.label} — planned for ${tool.milestone}` : tool.label}
          >
            <Icon size={21} />
            <span className="rail-label">{tool.label}</span>
            {tool.milestone && <span className="rail-badge">soon</span>}
          </button>
        )
      })}
    </nav>
  )
}
