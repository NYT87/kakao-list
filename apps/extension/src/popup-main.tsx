import React from "react";
import ReactDOM from "react-dom/client";
import PopupApp from "./PopupApp";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element for extension popup.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);
