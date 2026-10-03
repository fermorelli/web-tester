import { AuditReport } from "@/components/audit-report";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuditReport id={id} />;
}
