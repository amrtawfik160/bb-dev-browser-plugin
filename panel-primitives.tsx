import type { ComponentProps, ReactNode } from "react";

/**
 * The one place the plugin decides what a button, field, notice, glyph, or
 * list state looks like. Every class here names a host theme token, so both
 * surfaces follow BB's light and dark themes instead of carrying colors of
 * their own. These components are SDK-free so the panel chrome tests can
 * render them without the plugin app host.
 */

export type GlyphName =
  | "back"
  | "forward"
  | "reload"
  | "plus"
  | "close"
  | "more"
  | "external"
  | "check"
  | "dash"
  | "chevron";

// Drawn on a 16px grid with a 1.5px round stroke, the weight BB's own icons
// use, because plugins cannot import the host icon set and text glyphs render
// differently from one font to the next.
const GLYPH_PATHS: Record<GlyphName, string> = {
  back: "M10 3 5 8l5 5M5 8h8",
  forward: "m6 3 5 5-5 5M11 8H3",
  reload: "M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5h-2.5",
  plus: "M8 3v10M3 8h10",
  close: "m4 4 8 8M12 4l-8 8",
  more: "M4 8h.01M8 8h.01M12 8h.01",
  external: "M9 3h4v4M13 3 7 9M11 9v4H3V5h4",
  check: "m3 8 3 3 7-7",
  dash: "M4 8h8",
  chevron: "m6 4 4 4-4 4",
};

export function Glyph({
  name,
  className = "h-4 w-4",
}: {
  name: GlyphName;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={GLYPH_PATHS[name]} />
    </svg>
  );
}

export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

const BUTTON_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;

const BUTTON_VARIANTS = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary:
    "border border-border bg-card text-foreground hover:bg-state-hover",
  ghost: "text-foreground hover:bg-state-hover",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  link: "px-1 text-foreground underline underline-offset-4 hover:text-muted-foreground",
} as const;

const BUTTON_SIZES = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-9 px-3",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const sizing = variant === "link" ? "" : BUTTON_SIZES[size];
  return (
    <button
      type={type}
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${sizing} ${className}`}
      {...rest}
    />
  );
}

/**
 * A button that is only a glyph. The label is what assistive technology
 * reads and what the tooltip shows; the hit area is the panel's 28px control
 * height, or 36px for the medium size.
 */
export function IconButton({
  label,
  glyph,
  size = "sm",
  className = "",
  ...rest
}: ComponentProps<"button"> & {
  label: string;
  glyph: GlyphName;
  size?: ButtonSize;
}) {
  const box = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={label}
      title={label}
      className={`${box} shrink-0 px-0 ${className}`}
      {...rest}
    >
      <Glyph name={glyph} />
    </Button>
  );
}

export const inputClassName = `w-full min-w-0 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`;

export function Field({
  label,
  help,
  error = null,
  children,
}: {
  label: string;
  help?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-foreground">{label}</span>
      {children}
      {help === undefined ? null : (
        <span className="mt-1 block text-xs text-muted-foreground">{help}</span>
      )}
      {error === null ? null : (
        <span role="alert" className="mt-1 block text-xs text-destructive-text">
          {error}
        </span>
      )}
    </label>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className = "",
  ...rest
}: ComponentProps<"section"> & {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`text-left ${className}`} {...rest}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description === undefined ? null : (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
        )}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

const NOTICE_TONES = {
  info: "border-border bg-card text-foreground",
  warning: "border-attention/40 bg-surface-attention text-foreground",
  error:
    "border-surface-destructive-border bg-surface-destructive text-destructive-text",
} as const;

export function Notice({
  tone,
  children,
  className = "",
  ...rest
}: ComponentProps<"p"> & {
  tone: keyof typeof NOTICE_TONES;
  children: ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-sm ${NOTICE_TONES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </p>
  );
}

const DOT_TONES = {
  ready: "bg-success",
  settling: "bg-warning",
  blocked: "bg-destructive",
} as const;

export type StatusDotTone = keyof typeof DOT_TONES;

/** Color is never the only signal: the dot always carries its label. */
export function StatusDot({
  tone,
  label,
}: {
  tone: StatusDotTone;
  label: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_TONES[tone]}`}
    />
  );
}

export function LoadingState({ what }: { what: string }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Loading {what}…
    </p>
  );
}

export function EmptyState({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm">
      <p className="font-medium text-foreground">{title}</p>
      {children === undefined ? null : (
        <p className="mt-1 text-muted-foreground">{children}</p>
      )}
      {action === undefined ? null : <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Notice tone="error" className="grow">
        {message}
      </Notice>
      {onRetry === undefined ? null : (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
