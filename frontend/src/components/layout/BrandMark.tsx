import { cn } from "@/lib/utils";

export interface BrandMarkProps {
  /** Edge size in pixels; the mark is drawn on a 32×32 grid. */
  size?: number;
  className?: string;
  /** Adds the blinking prompt caret used on hero surfaces. */
  animated?: boolean;
}

/**
 * Duc's Table logo: a data grid with a SQL prompt badge, matching the
 * application icon. Drawn inline so it stays crisp at every size and can
 * inherit brand colors from the theme.
 */
export function BrandMark({ size = 22, className, animated = false }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Duc's Table"
      className={cn("overflow-visible", className)}
    >
      <defs>
        <linearGradient id="ducs-mark-stroke" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#97fbc8" />
          <stop offset="0.55" stopColor="#34e07f" />
          <stop offset="1" stopColor="#0da95a" />
        </linearGradient>
        <linearGradient id="ducs-mark-fill" x1="6" y1="6" x2="20" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#c8ffe1" />
          <stop offset="1" stopColor="#34e07f" />
        </linearGradient>
      </defs>

      {/* Table frame */}
      <rect x="3.25" y="4.25" width="25.5" height="23.5" rx="6.25" stroke="url(#ducs-mark-stroke)" strokeWidth="1.6" />

      {/* Header row */}
      <path d="M3.5 11.5H28.5" stroke="url(#ducs-mark-stroke)" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="6.5" y="7.6" width="5" height="1.8" rx="0.9" fill="url(#ducs-mark-fill)" opacity="0.95" />
      <rect x="13.5" y="7.6" width="5" height="1.8" rx="0.9" fill="url(#ducs-mark-fill)" opacity="0.7" />
      <rect x="20.5" y="7.6" width="5" height="1.8" rx="0.9" fill="url(#ducs-mark-fill)" opacity="0.45" />

      {/* Key column highlighted, remaining cells implied by the column rule */}
      <rect x="6.4" y="14" width="6.2" height="4" rx="1.3" fill="url(#ducs-mark-fill)" opacity="0.9" />
      <rect x="6.4" y="19.6" width="6.2" height="4" rx="1.3" fill="url(#ducs-mark-fill)" opacity="0.55" />
      <path d="M15.4 11.9V27.4" stroke="url(#ducs-mark-stroke)" strokeWidth="1.1" opacity="0.5" strokeLinecap="round" />

      {/* SQL prompt badge */}
      <g>
        <rect x="16.5" y="16.5" width="14" height="12" rx="4" fill="#04120b" stroke="url(#ducs-mark-stroke)" strokeWidth="1.5" />
        <path d="M20 20.4L22.1 22.5L20 24.6" stroke="url(#ducs-mark-stroke)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <rect
          x="23.6"
          y="23.4"
          width="4"
          height="1.7"
          rx="0.85"
          fill="url(#ducs-mark-fill)"
          className={animated ? "ducs-pulse" : undefined}
        />
      </g>
    </svg>
  );
}

export interface WordmarkProps {
  className?: string;
}

/** Typographic lockup used next to the mark in the title bar. */
export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={cn("ducs-display select-none text-[13.5px] leading-none", className)}>
      <span className="ducs-brand-text">Duc&apos;s</span>
      <span className="ml-1 font-medium text-foreground/85">Table</span>
    </span>
  );
}
