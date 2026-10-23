// One field of every type: the spec tests/forms.test.ts, tests/secrets.test.ts and tests/formCard.test.tsx share.
export const EVERY_TYPE = [
  { name: "project", label: "Project name", type: "text", required: true, placeholder: "orca", max: 40 },
  { name: "notes", label: "Notes", type: "textarea", help: "Anything the agent should know." },
  { name: "replicas", label: "Replicas", type: "number", min: 1, max: 10, default: 2 },
  { name: "launch", label: "Launch date", type: "date", min: "2026-01-01" },
  { name: "window", label: "Maintenance window", type: "datetime" },
  { name: "region", label: "Region", type: "select", options: ["eu-west-2", { value: "us-east-1", label: "US East" }], required: true },
  { name: "features", label: "Features", type: "multiselect", options: ["auth", "billing", "search"], min: 1 },
  { name: "agree", label: "I accept the terms", type: "checkbox", required: true },
  { name: "homepage", label: "Homepage", type: "url" },
  { name: "contact", label: "Contact email", type: "email" },
  { name: "api_key", label: "API key", type: "secret", required: true, scope: "billing" },
];
