import { useState, useEffect, useRef } from "react";

/**
 * Count-up animation for numerical values.
 * - First mount: animates from 0 to target
 * - Subsequent updates: snaps to new target (no re-animation)
 * - Respects prefers-reduced-motion: skips animation entirely
 */
export function useCountUp(target: number, duration = 400): number {
  const [value, setValue] = useState(0);
  const hasAnimatedRef = useRef(false);

  useEffect(() => {
    // After first animation, snap to target immediately on updates
    if (hasAnimatedRef.current) {
      setValue(target);
      return;
    }

    // Check reduced motion preference
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      hasAnimatedRef.current = true;
      setValue(target);
      return;
    }

    hasAnimatedRef.current = true;

    if (target === 0) {
      setValue(0);
      return;
    }

    const start = performance.now();
    let rafId: number;

    const step = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      setValue(Math.floor(progress * target));
      if (progress < 1) {
        rafId = requestAnimationFrame(step);
      }
    };

    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
  }, [target, duration]);

  return value;
}
