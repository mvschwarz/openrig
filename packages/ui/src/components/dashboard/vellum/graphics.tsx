// Per-destination wireframe graphics. Small technical line drawings,
// one per card. Each ~60×60 viewBox, sharp 1px stroke, fill-none.

export function StratigraphicGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M2 26 Q 18 18 30 22 T 58 18" />
      <path d="M2 36 Q 18 28 30 32 T 58 28" strokeDasharray="2 2" />
      <path d="M2 46 Q 18 40 30 42 T 58 38" strokeDasharray="2 2" />
      <circle cx="30" cy="22" r="2" fill="currentColor" />
      <line x1="30" y1="22" x2="30" y2="10" />
      <text x="34" y="12" fontSize="6" fontFamily="monospace" fill="currentColor" fontWeight="bold">[01]</text>
    </svg>
  );
}

export function TreeGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="22" y="6" width="16" height="8" />
      <rect x="6" y="28" width="14" height="8" />
      <rect x="40" y="28" width="14" height="8" />
      <rect x="6" y="48" width="14" height="6" />
      <rect x="22" y="48" width="14" height="6" />
      <rect x="40" y="48" width="14" height="6" />
      <line x1="30" y1="14" x2="13" y2="28" />
      <line x1="30" y1="14" x2="47" y2="28" />
      <line x1="13" y1="36" x2="13" y2="48" />
      <line x1="47" y1="36" x2="47" y2="48" />
      <line x1="13" y1="44" x2="29" y2="48" />
      <line x1="47" y1="44" x2="29" y2="48" />
    </svg>
  );
}

export function PulseGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <circle cx="30" cy="30" r="4" fill="currentColor" />
      <circle cx="30" cy="30" r="12" />
      <circle cx="30" cy="30" r="20" strokeDasharray="2 3" />
      <circle cx="30" cy="30" r="27" strokeDasharray="2 4" />
      <line x1="30" y1="0" x2="30" y2="60" strokeDasharray="2 3" />
      <line x1="0" y1="30" x2="60" y2="30" strokeDasharray="2 3" />
    </svg>
  );
}

// Gyroscope-style globe: outer circle + crossed ellipses (equator +
// meridian) + crosshair dashed lines extending across the full canvas +
// filled center dot.
export function SphereGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <circle cx="30" cy="30" r="26" />
      <ellipse cx="30" cy="30" rx="26" ry="9" />
      <ellipse cx="30" cy="30" rx="9" ry="26" />
      <line x1="0" y1="30" x2="60" y2="30" strokeDasharray="2 3" />
      <line x1="30" y1="0" x2="30" y2="60" strokeDasharray="2 3" />
      <circle cx="30" cy="30" r="3" fill="currentColor" />
    </svg>
  );
}

export function MagnifierGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="24" cy="24" r="14" />
      <line x1="20" y1="24" x2="28" y2="24" />
      <line x1="24" y1="20" x2="24" y2="28" />
      <line x1="34" y1="34" x2="52" y2="52" strokeWidth="1.6" />
      <line x1="48" y1="48" x2="55" y2="48" />
      <line x1="48" y1="48" x2="48" y2="55" />
    </svg>
  );
}

export function GearGraphic() {
  return (
    <svg className="w-full h-full text-stone-900" viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="1">
      <circle cx="30" cy="30" r="20" />
      <circle cx="30" cy="30" r="12" />
      <circle cx="30" cy="30" r="3" fill="currentColor" />
      {/* 8 gear teeth */}
      <line x1="30" y1="6" x2="30" y2="11" strokeWidth="1.5" />
      <line x1="30" y1="49" x2="30" y2="54" strokeWidth="1.5" />
      <line x1="6" y1="30" x2="11" y2="30" strokeWidth="1.5" />
      <line x1="49" y1="30" x2="54" y2="30" strokeWidth="1.5" />
      <line x1="13" y1="13" x2="17" y2="17" strokeWidth="1.5" />
      <line x1="43" y1="13" x2="47" y2="17" strokeWidth="1.5" />
      <line x1="13" y1="47" x2="17" y2="43" strokeWidth="1.5" />
      <line x1="43" y1="47" x2="47" y2="43" strokeWidth="1.5" />
    </svg>
  );
}
