// A throwaway harness, not linked from the app and not part of `vite build`'s default entry (only
// index.html is): it renders the REAL form card (components/FormCard.tsx) and the REAL chat composer
// with no bridge behind them, for orca-shot screenshots of a feature the preview bridge cannot show
// (it never migrates, so the shared database has no `form` table). `?view=` picks the piece:
// `open` (one field of every type), `submitted` (the answered card) or `guard` (the composer: type a
// key and press Enter to show the paste guard).
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./lib/theme"; // applies the OS theme, so `orca-shot --dark` shows the dark card
import { FormBody } from "@/components/FormCard";
import { ChatComposer } from "@/components/ChatComposer";
import { parseFormSpec, splitAnswers, type FormView } from "../../shared/forms";

const FIELDS = [
  { name: "project", label: "Project name", type: "text", required: true, placeholder: "orca", max: 40 },
  { name: "notes", label: "Notes", type: "textarea", help: "Anything the agent should know." },
  { name: "replicas", label: "Replicas", type: "number", min: 1, max: 10, default: 2 },
  { name: "launch", label: "Launch date", type: "date", min: "2026-01-01" },
  { name: "window", label: "Maintenance window", type: "datetime" },
  { name: "region", label: "Region", type: "select", options: ["eu-west-2", { value: "us-east-1", label: "US East" }], required: true },
  { name: "features", label: "Features", type: "multiselect", options: ["auth", "billing", "search"], min: 1 },
  { name: "agree", label: "I accept the terms", type: "checkbox", required: true },
  { name: "homepage", label: "Homepage", type: "url", placeholder: "https://" },
  { name: "contact", label: "Contact email", type: "email" },
  { name: "api_key", label: "API key", type: "secret", required: true, scope: "billing", help: "From the billing dashboard." },
];
const spec = parseFormSpec({ title: "Set up billing", intro: "Two minutes. The API key is stored encrypted.", fields: FIELDS });
const open: FormView = { ...spec, id: "harness", state: "open", createdAt: Date.now() };
const values = { project: "orca", notes: "Start with EU only.", replicas: "3", launch: "2026-11-02", window: "2026-11-02T22:00", region: "eu-west-2", features: ["auth", "billing"], agree: true, homepage: "https://example.com", contact: "ops@example.com", api_key: "not-shown" };
const submitted: FormView = { ...open, state: "submitted", answers: splitAnswers(spec, values).answers, answeredAt: Date.now() };

function Harness() {
  const view = new URLSearchParams(location.search).get("view") ?? "open";
  return (
    <div className="bg-background text-foreground min-h-screen p-6 text-sm">
      <div className="mx-auto max-w-xl">
        {view === "guard"
          ? <ChatComposer onSubmit={async () => {}} placeholder="Message the orchestrator…" />
          : <FormBody form={view === "submitted" ? submitted : open} onDone={() => {}} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
