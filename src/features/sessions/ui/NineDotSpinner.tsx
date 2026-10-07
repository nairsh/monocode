const DOT_DELAYS = [-800, -650, -500, -650, -500, -350, -500, -350, -200];

export function NineDotSpinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-grid size-3 shrink-0 grid-cols-3 grid-rows-3 gap-[1.5px] ${className}`}
    >
      {DOT_DELAYS.map((delay, index) => (
        <span
          key={index}
          className="sidebar-working-dot rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
