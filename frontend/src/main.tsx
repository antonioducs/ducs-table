import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installWailsErrorNormalizer } from "./lib/wails-error-normalizer";
import "./index.css";

installWailsErrorNormalizer();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
