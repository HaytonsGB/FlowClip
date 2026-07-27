/**
 * Inline SVG icon set. Stroke-based on a 24px grid, inheriting currentColor so
 * the rail can restyle them by state without swapping assets.
 */
interface IconProps {
  size?: number
}

function Svg({ size = 22, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function ScissorsIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <line x1="20" y1="4" x2="8.4" y2="15.6" />
      <line x1="14" y1="12.6" x2="20" y2="20" />
      <line x1="8.4" y1="8.4" x2="11.2" y2="11.2" />
    </Svg>
  )
}

export function CropIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.5 2v15.5H22" />
      <path d="M2 6.5h15.5V22" />
    </Svg>
  )
}

export function LayersIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="3.5" y="3" width="17" height="7" rx="1.6" />
      <rect x="3.5" y="13" width="10" height="8" rx="1.6" />
      <rect x="15.5" y="13" width="5" height="8" rx="1.6" />
    </Svg>
  )
}

export function PlusIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  )
}

export function ArrowUpIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <path d="M6 11l6-6 6 6" />
    </Svg>
  )
}

export function ArrowDownIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <path d="M6 13l6 6 6-6" />
    </Svg>
  )
}

export function TrashIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 6.5h16" />
      <path d="M9 6.5V4.5h6v2" />
      <path d="M6 6.5l1 13h10l1-13" />
    </Svg>
  )
}

export function CaptionsIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="M9 10.5a2.5 2.5 0 1 0 0 3" />
      <path d="M16.5 10.5a2.5 2.5 0 1 0 0 3" />
    </Svg>
  )
}

export function MusicIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6.5" cy="18" r="2.6" />
      <circle cx="17.5" cy="16" r="2.6" />
    </Svg>
  )
}

export function TextIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 6.5V4.5h16v2" />
      <line x1="12" y1="4.5" x2="12" y2="19.5" />
      <line x1="8.5" y1="19.5" x2="15.5" y2="19.5" />
    </Svg>
  )
}

export function StickerIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M21 12a9 9 0 1 0-9 9c1 0 9-8 9-9Z" />
      <path d="M13 21c0-4 4-8 8-8" />
      <circle cx="9" cy="10" r="1" />
      <circle cx="15" cy="10" r="1" />
      <path d="M9 14.5a4 4 0 0 0 4 1.2" />
    </Svg>
  )
}

export function EffectsIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
    </Svg>
  )
}

export function PlayIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M7 4.5l12 7.5-12 7.5V4.5Z" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function PauseIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="6.5" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.5" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function ExportIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3v12" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4 17v2.5h16V17" />
    </Svg>
  )
}

export function MarkInIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 4v16" />
      <path d="M10 12h9" />
      <path d="M15 8l4 4-4 4" />
    </Svg>
  )
}

export function MarkOutIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M19 4v16" />
      <path d="M14 12H5" />
      <path d="M9 8l-4 4 4 4" />
    </Svg>
  )
}

export function ResetIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 4.5V10H9" />
    </Svg>
  )
}
