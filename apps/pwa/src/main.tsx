import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerPwaUpdateLifecycle } from "./pwaUpdate";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();
registerPwaUpdateLifecycle();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
