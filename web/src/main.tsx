import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { locale } from "./i18n/index.js";
import { paintChoice, storedChoice } from "./theme.js";
import "./index.css";

// Paint only: App applies the choice and owns the System listener, so none leaks past a later Light or Dark.
paintChoice(storedChoice());
document.documentElement.lang = locale();
// react-aria's usePress prepends an inline <style> unless an element with this id exists, and the CSP's
// style-src 'self' refuses it. This empty marker stops that; index.css carries its touch-action rule.
const pressableStyleMarker = document.createElement("meta");
pressableStyleMarker.id = "react-aria-pressable-style";
document.head.append(pressableStyleMarker);
const client = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
