import React from "react";
import ReactDOM from "react-dom/client";
import OptionsApp from "./OptionsApp";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OptionsApp />
  </React.StrictMode>
);
