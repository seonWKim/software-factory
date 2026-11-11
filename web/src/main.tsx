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
const client = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
