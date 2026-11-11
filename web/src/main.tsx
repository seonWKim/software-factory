import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { locale } from "./i18n/index.js";
import { applyChoice, storedChoice } from "./theme.js";
import "./index.css";

applyChoice(storedChoice());
document.documentElement.lang = locale();
const client = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
