import { useSyncExternalStore } from 'react';

/** Phone layouts: narrow screens, or a phone held sideways. Keep in step with the media query in styles.css. */
export const MOBILE_QUERY = '(max-width: 700px), (max-height: 500px) and (pointer: coarse)';
/** Pointers that cannot hover (a finger): no hover affordances, no double click, no keyboard shortcuts. */
export const TOUCH_QUERY = '(hover: none)';

const match = (query: string) => (typeof matchMedia === 'function' ? matchMedia(query) : null);
export const isTouch = () => !!match(TOUCH_QUERY)?.matches;
export const isMobile = () => !!match(MOBILE_QUERY)?.matches;

function useQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const m = match(query);
      m?.addEventListener('change', notify);
      return () => m?.removeEventListener('change', notify);
    },
    () => !!match(query)?.matches,
    () => false,
  );
}

export const useMobile = () => useQuery(MOBILE_QUERY);
export const useTouch = () => useQuery(TOUCH_QUERY);
