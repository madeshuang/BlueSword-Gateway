import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  locked = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  locked?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`conversation-modal${wide ? " modal-wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
    >
      <header className="modal-header">
        <div>
          <span className="brand-eyebrow">BLUESWORD ASSISTANT</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="关闭弹窗"
          disabled={locked}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
