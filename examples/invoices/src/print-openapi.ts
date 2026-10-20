// Prints the example's OpenAPI document, for Spectral to lint in CI.
import { createOpenApiDocument } from "@syrinx/rest";
import { createInvoicesHost } from "./host.js";

const { registry } = createInvoicesHost();
const document = createOpenApiDocument(registry, {
  title: "Invoices example",
  description: "Invoices and customers served by Syrinx: one registry over REST, MCP and views.",
  version: "1.0.0",
  contact: { name: "Syrinx maintainers" },
  servers: [{ url: "http://localhost:3000" }],
});
process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
