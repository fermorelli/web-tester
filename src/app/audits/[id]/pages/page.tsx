import { PageInspector } from "@/components/page-inspector";

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ url?: string }>;
}) {
  const [{ id }, { url }] = await Promise.all([params, searchParams]);
  return <PageInspector id={id} url={url ?? ""} />;
}
