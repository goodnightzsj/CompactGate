import { createRoot } from "react-dom/client";
import { StudioApp } from "./app/StudioApp.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<StudioApp />);
