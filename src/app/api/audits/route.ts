import { after } from "next/server";
import { AuditInputError, auditRepository, executeAudit, prepareAudit } from "@/services/audits";
import { json, readSmallJson, validateLocalRequest, validateLocalWrite } from "@/services/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const invalid = validateLocalRequest(request);
  if (invalid) return json({ error: invalid }, 403);
  try { return json({ audits: auditRepository().listAudits() }); }
  catch { return json({ error: "Unable to load the audit history." }, 500); }
}

export async function POST(request: Request) {
  const invalid = validateLocalWrite(request);
  if (invalid) return json({ error: invalid }, 403);
  let body: unknown;
  try { body = await readSmallJson(request); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid JSON request body." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "The request body must be a JSON object." }, 400);
  const input = body as Record<string, unknown>;
  try {
    const audit = await prepareAudit(input.url, input.maxPages ?? 100);
    after(() => executeAudit(audit));
    return json({ audit }, 202);
  } catch (error) {
    if (error instanceof AuditInputError) return json({ error: error.message }, error.status);
    console.error("Unable to start the audit:", error);
    return json({ error: "Unable to start the audit. Check the server logs." }, 500);
  }
}
