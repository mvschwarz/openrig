import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ThemeProvider } from "./components/ThemeProvider.js";
import { primeMissionControlBearerTokenFromUrl } from "./components/mission-control/missionControlAuth.js";

// The UI takes its tokens from its address: a person who holds them opens it once with ?termToken=…&mcToken=…, and this
// keeps them in the browser and takes them out of the address bar before anything renders.
primeMissionControlBearerTokenFromUrl();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  );
}
