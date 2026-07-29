import type { ReactNode } from "react";
import { ColorModeToggle } from "./ColorModeToggle.js";

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-paper px-4 py-8">
      <ColorModeToggle className="absolute right-4 top-4" />
      <div className="w-full max-w-md rounded-card border border-rule bg-paper p-6 md:p-8">
        <h1 className="font-display text-2xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
        {footer && (
          <div className="mt-6 border-t border-rule pt-4 text-center text-sm text-muted">{footer}</div>
        )}
      </div>
    </div>
  );
}

export const authInputClass =
  "h-11 w-full rounded-md border border-rule-2 bg-paper px-3 text-sm text-ink outline-2 outline-offset-1 outline-transparent transition-colors duration-short ease-out placeholder:text-muted hover:bg-paper-2 focus:bg-paper focus:outline-focus";

export const authLabelClass = "mb-1.5 block text-sm font-medium text-ink-2";

export const authPrimaryButtonClass =
  "flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50";
