/* Ported from OpenAgentCore apps/web/src/components/Modal.tsx (first-party,
 * same team). SandBase local changes:
 * - the `size` prop replaces OAC's `wide` flag: default 448px, medium/wide
 *   960px, workflow 1160px (the agent create/edit split-column dialog);
 * - an optional `subtitle` line under the title;
 * - `open` defaults to true: callers here mount the dialog conditionally, so
 *   the 200ms close-out runs only when a caller keeps it mounted and toggles
 *   `open` to false — focus trap, focus restore and Escape work either way;
 * - the close button's aria-label is a literal until the i18n layer lands.
 */
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type PropsWithChildren, type ReactNode, type RefObject } from 'react';

export type ModalSize = 'default' | 'medium' | 'wide' | 'workflow';

const SIZE_CLASS: Record<ModalSize, string> = {
  default: '',
  medium: 'modal-card-medium',
  wide: 'modal-card-wide',
  workflow: 'modal-card-workflow',
};

interface ModalProps extends PropsWithChildren {
  open?: boolean;
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  onClose: () => void;
  size?: ModalSize;
  /** What takes focus on open, such as a confirmation's default action; otherwise the first field, then the first control. */
  initialFocus?: RefObject<HTMLElement | null>;
}

export function Modal({ open = true, title, subtitle, footer, onClose, size = 'default', initialFocus, children }: ModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const initialFocusRef = useRef(initialFocus);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  onCloseRef.current = onClose;
  initialFocusRef.current = initialFocus;

  useEffect(() => {
    if (open) {
      if (!wasOpenRef.current) {
        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      wasOpenRef.current = true;
      setMounted(true);
      setClosing(false);
      return;
    }
    wasOpenRef.current = false;
    if (!mounted) return;

    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [mounted, open]);

  useEffect(() => {
    if (!open || !mounted) return;

    const dialog = dialogRef.current;
    const focusableSelector = [
      'button:not([disabled])',
      'input:not([disabled])',
      'textarea:not([disabled])',
      'select:not([disabled])',
      'a[href]',
      "[tabindex]:not([tabindex='-1'])",
    ].join(',');
    const frame = window.requestAnimationFrame(() => {
      const preferred = dialog?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
      const first = initialFocusRef.current?.current ?? preferred ?? dialog?.querySelector<HTMLElement>(focusableSelector) ?? dialog;
      first?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.classList.add('modalOpen');
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.classList.remove('modalOpen');
      previousFocusRef.current?.focus();
    };
  }, [mounted, open]);

  if (!mounted) return null;

  const sizeClass = SIZE_CLASS[size];
  return (
    <div
      className={`modal-backdrop${closing ? ' closing' : ''}`}
      role="presentation"
      aria-hidden={closing || undefined}
      onMouseDown={() => {
        if (!closing) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={sizeClass ? `modal-card ${sizeClass}` : 'modal-card'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
            <X size={14} strokeWidth={1.5} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </section>
    </div>
  );
}
