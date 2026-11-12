import { type AnchorHTMLAttributes, type MouseEvent, createContext, useContext, useEffect, useState } from "react";

// In-app navigation: history.pushState under /app/, no router dependency. A plain click on a Link navigates in
// place; a modified click (new tab, etc.) is left to the browser.

const NavContext = createContext<(to: string) => void>(() => undefined);

/** The current location path, and a navigate function that pushes a new one (`replace`: swaps the current entry). */
export function useLocationPath(): [string, (to: string, replace?: boolean) => void] {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string, replace = false) => {
    if (to === location.pathname) return;
    if (replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    setPath(to);
    // The app's content column scrolls, not the window (App.tsx); a new page starts at its top.
    const root = document.querySelector("[data-scroll-root]");
    if (root) root.scrollTop = 0;
  };
  return [path, navigate];
}

export const NavProvider = NavContext.Provider;

export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const navigate = useContext(NavContext);
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={click} {...props} />;
}
