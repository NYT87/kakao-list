import React from "react";
import ReactDOM from "react-dom/client";
import PopupApp from "./PopupApp";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>
);
