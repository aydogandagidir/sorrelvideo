import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudioApp } from "@hyperframes/studio";
import "@studio/studio.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <StudioApp />
    </StrictMode>,
  );
}
