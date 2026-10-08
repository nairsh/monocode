import {
  Check,
  ChevronDown,
  Lock,
  Pencil,
  Shield,
  ShieldCode,
} from "../../../shared/ui/icons";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  RUNTIME_MODE_HINT,
  RUNTIME_MODE_LABEL,
  RUNTIME_MODES,
  type RuntimeMode,
} from "../model/session";
import {
  MENU_CHECK,
  MENU_ICON,
  MENU_ROW,
  MENU_WIDTH,
  Popover,
} from "../../../shared/ui/Popover";

type Props = {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  onClose?: () => void;
  busy?: boolean;
  side?: "top" | "bottom";
  /** `ghost`: just the mode's icon, for the composer row. */
  variant?: "pill" | "plain" | "ghost";
};

const ICONS: Record<RuntimeMode, typeof Lock | typeof ShieldCode> = {
  supervised: Lock,
  "auto-accept-edits": Pencil,
  auto: ShieldCode,
  "full-access": Shield,
};

export function AccessPicker({
  value,
  onChange,
  onClose,
  busy = false,
  side = "top",
  variant = "pill",
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(0, RUNTIME_MODES.indexOf(value)),
  );
  const root = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const Icon = ICONS[value];

  const dismiss = (restore: boolean) => {
    setOpen(false);
    if (restore) onCloseRef.current?.();
  };

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, RUNTIME_MODES.indexOf(value)));
  }, [open, value]);

  const pick = (mode: RuntimeMode) => {
    onChange(mode);
    dismiss(true);
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(RUNTIME_MODES.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const mode = RUNTIME_MODES[active];
      if (mode) pick(mode);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-access-picker-trigger
        title={`${variant === "ghost" ? `${RUNTIME_MODE_LABEL[value]}: ` : ""}${RUNTIME_MODE_HINT[value]}${busy ? " Changes apply to the next turn." : ""}`}
        aria-label={RUNTIME_MODE_LABEL[value]}
        aria-expanded={open}
        aria-haspopup="listbox"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) {
            dismiss(true);
            return;
          }
          setOpen(true);
        }}
        className={
          variant === "ghost"
            ? `grid size-7 place-items-center rounded-full transition-colors ${
                open
                  ? "bg-content/8 text-content"
                  : "text-content/60 hover:bg-content/6 hover:text-content"
              }`
            : variant === "plain"
              ? `-mx-1.5 flex h-7 max-w-52 items-center gap-2 rounded-md px-1.5 text-[12px] text-content/85 ${
                  open ? "bg-content/8" : "hover:bg-content/6"
                }`
              : `flex h-6.5 max-w-52 items-center gap-1 rounded-md px-1.5 ${
                  open
                    ? "bg-selection text-content"
                    : "bg-selection text-content hover:bg-selection-hover"
                }`
        }
      >
        <Icon
          className={`${variant === "ghost" ? "size-[15px]" : "size-3.5"} shrink-0 ${value === "full-access" ? "text-amber-400/90" : ""}`}
          strokeWidth={1.75}
        />
        {variant === "ghost" ? null : (
          <>
            <span
              className={`min-w-0 truncate ${variant === "pill" ? "text-[11px]" : ""}`}
            >
              {RUNTIME_MODE_LABEL[value]}
            </span>
            <ChevronDown
              className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`}
              strokeWidth={1.75}
            />
          </>
        )}
      </button>
      {open ? (
        <Popover
          anchor={root}
          side={side}
          width={MENU_WIDTH}
          rounded="rounded-2xl"
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="listbox"
          aria-label="Access"
          data-access-picker
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="p-1.5 font-sans"
        >
          {RUNTIME_MODES.map((mode, index) => {
            const ModeIcon = ICONS[mode];
            const selected = mode === value;
            const highlighted = index === active;
            return (
              <button
                key={mode}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(mode)}
                title={RUNTIME_MODE_HINT[mode]}
                className={`${MENU_ROW} ${highlighted ? "bg-content/6" : ""}`}
              >
                <ModeIcon
                  className={
                    mode === "full-access"
                      ? "size-4 shrink-0 text-amber-400/90"
                      : MENU_ICON
                  }
                  strokeWidth={1.5}
                />
                <span className="min-w-0 flex-1 truncate">
                  {RUNTIME_MODE_LABEL[mode]}
                </span>
                {selected ? (
                  <Check className={MENU_CHECK} strokeWidth={1.75} />
                ) : null}
              </button>
            );
          })}
          {busy ? (
            <p className="px-2.5 py-1.5 text-[11px] leading-4 text-content/50">
              Access changes apply to the next turn. Stop and resend to apply
              them now.
            </p>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}
