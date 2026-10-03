import { auditRepository } from "@/services/audits";
import { configuredAppOrigin, json } from "@/services/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    configuredAppOrigin();
    auditRepository().listAudits(1);
    return json({ status: "ok" });
  } catch {
    return json({ status: "unavailable" }, 503);
  }
}
