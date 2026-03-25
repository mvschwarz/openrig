import { RouterProvider } from "@tanstack/react-router";
import { router } from "./routes.js";

export function App() {
  return <RouterProvider router={router} />;
}
