import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Link, type LinkProps } from "react-router-dom";

type Tone = "primary" | "default" | "quiet" | "danger";

export function Button({
  tone = "default",
  busy,
  small,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; busy?: boolean; small?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={`btn btn-${tone}${small ? " btn-sm" : ""}${className ? ` ${className}` : ""}`}
    >
      {busy ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ tone = "default", small, className, ...rest }: LinkProps & { tone?: Tone; small?: boolean }) {
  return <Link {...rest} className={`btn btn-${tone}${small ? " btn-sm" : ""}${className ? ` ${className}` : ""}`} />;
}

export function PageHeader({ title, lead, actions, back }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="page-head">
      {back ? <div className="page-back">{back}</div> : null}
      <div className="page-head-row">
        <div className="page-head-text">
          <h1>{title}</h1>
          {lead ? <p className="lead">{lead}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Panel({
  title,
  hint,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`} id={id}>
      {title || actions ? (
        <div className="panel-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {hint ? <p className="hint">{hint}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="field-hint">{hint}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ label, hint, error, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={rest.id ?? id}>
      <input id={rest.id ?? id} className="input" {...rest} />
    </Field>
  );
}

export function TextArea({ label, hint, error, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode; error?: string }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={rest.id ?? id}>
      <textarea id={rest.id ?? id} className="input textarea" {...rest} />
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={rest.id ?? id}>
      <select id={rest.id ?? id} className="input select" {...rest}>
        {children}
      </select>
    </Field>
  );
}

export function Check({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...rest} />
      <span>
        {label}
        {hint ? <small className="check-hint">{hint}</small> : null}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="segmented">
      <legend className="field-label">{label}</legend>
      <div className="segmented-row">
        {options.map((o) => (
          <label key={o.value} className={o.value === value ? "on" : ""}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

type BadgeTone = "neutral" | "ok" | "warn" | "bad" | "info" | "accent";

export function Badge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
  actions,
  role,
}: {
  tone?: "info" | "warn" | "bad" | "ok";
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div className={`notice notice-${tone}`} role={role ?? (tone === "bad" ? "alert" : undefined)}>
      <span className="notice-icon" aria-hidden>
        {tone === "ok" ? "✓" : tone === "bad" ? "!" : tone === "warn" ? "!" : "i"}
      </span>
      <div className="notice-body">
        {title ? <strong className="notice-title">{title}</strong> : null}
        {children ? <div>{children}</div> : null}
        {actions ? <div className="notice-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="inline-error" role="alert">
      {children}
    </p>
  );
}

export function Empty({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-text">{children}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

export function Loading({ children = "正在读取…" }: { children?: ReactNode }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden />
      {children}
    </p>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: Array<{ value: T; label: ReactNode; count?: number }>;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          className={t.value === value ? "tab on" : "tab"}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 原生 dialog：Esc 可关，焦点自动进入。 */
export function Dialog({
  open,
  title,
  children,
  actions,
  onClose,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`dialog${wide ? " dialog-wide" : ""}`} onClose={onClose} aria-label={typeof title === "string" ? title : "确认操作"}>
      {open ? (
        <>
          <div className="dialog-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {actions ? <div className="dialog-actions">{actions}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

/** 关键词高亮：按字面匹配，忽略英文大小写。 */
export function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const at = lower.indexOf(n, i);
    if (at < 0) break;
    if (at > i) out.push(text.slice(i, at));
    out.push(<mark key={k++}>{text.slice(at, at + needle.length)}</mark>);
    i = at + needle.length;
  }
  out.push(text.slice(i));
  return <>{out}</>;
}

export function Stat({ value, label, to }: { value: ReactNode; label: ReactNode; to?: string }) {
  const inner = (
    <>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </>
  );
  return to ? (
    <Link className="stat" to={to}>
      {inner}
    </Link>
  ) : (
    <div className="stat">{inner}</div>
  );
}
