import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerPwaUpdateLifecycle } from "./pwaUpdate";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();
registerPwaUpdateLifecycle();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element for PWA.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
