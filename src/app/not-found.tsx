import Link from "next/link";
import { Shell } from "@/components/shell";

export default function NotFound() {
  return <Shell><div className="empty-state standalone"><span className="eyebrow">404 · PAGE NOT FOUND</span><h1>This page could not be found.</h1><p>Return home to run an audit or open a saved report.</p><Link className="button primary" href="/">Go home</Link></div></Shell>;
}
