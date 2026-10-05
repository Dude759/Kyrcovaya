type BrandMarkProps = {
  size?: number;
  tone?: "dark" | "green";
};

export function BrandMark({ size = 44, tone = "dark" }: BrandMarkProps) {
  return (
    <span
      className={`brand-mark brand-mark--${tone}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="brand-mark__stem" />
      <span className="brand-mark__route brand-mark__route--top" />
      <span className="brand-mark__route brand-mark__route--middle" />
      <span className="brand-mark__route brand-mark__route--bottom" />
      <span className="brand-mark__point" />
    </span>
  );
}
