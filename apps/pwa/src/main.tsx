import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Ignore registration errors in the scaffold stage.
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
