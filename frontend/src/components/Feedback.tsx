import { Link } from "react-router-dom";
export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <p className="form-error" role="alert">
      {message}
    </p>
  ) : null;
}
export function EmptyState({
  title,
  text,
  to,
  label,
}: {
  title: string;
  text?: string;
  to?: string;
  label?: string;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {to && (
        <Link className="button" to={to}>
          {label ?? "Открыть карту"}
        </Link>
      )}
    </div>
  );
}
