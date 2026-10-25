import React from "react";
import ReactDOM from "react-dom/client";
import OptionsApp from "./OptionsApp";
import { RecoveryBoundary } from "./RecoveryBoundary";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element for extension options.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RecoveryBoundary>
      <OptionsApp />
    </RecoveryBoundary>
  </React.StrictMode>,
);
