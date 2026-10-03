import { auditRepository } from "@/services/audits";
import { json, validAuditId, validateLocalRequest } from "@/services/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const invalid = validateLocalRequest(_request);
  if (invalid) return json({ error: invalid }, 403);
  const { id } = await params;
  if (!validAuditId(id)) return json({ error: "Invalid audit ID." }, 400);
  try {
    const audit = auditRepository().getAudit(id);
    if (!audit) return json({ error: "Audit not found." }, 404);
    return new Response(JSON.stringify(audit, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="site-inspector-${id}.json"` },
    });
  } catch { return json({ error: "Unable to export the audit." }, 500); }
}
