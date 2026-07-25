import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { LandingNav } from "@/components/laygrounded/landing-nav";
import { Footer } from "@/components/laygrounded/footer/Footer";
import staticStyles from "@/app/StaticPage.module.css";
import styles from "../Knowledge.module.css";
import { getClauseBySlug, listClauses } from "@/lib/knowledge/query";

export const revalidate = 3600;

const FORM_LABEL: Record<string, string> = {
  GENCON94: "GENCON 94",
  ASBATANKVOY: "ASBATANKVOY",
  GENERAL: "Concept",
};

export async function generateStaticParams() {
  const clauses = await listClauses();
  return clauses.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const clause = await getClauseBySlug(slug);
  if (!clause) return { title: "Not found — LayGrounded Knowledge Base" };
  const description = clause.body.slice(0, 155);
  return {
    title: `${clause.title} — LayGrounded`,
    description,
    alternates: { canonical: `/knowledge/${clause.slug}` },
    openGraph: { title: clause.title, description, type: "article" },
  };
}

export default async function ClausePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const clause = await getClauseBySlug(slug);
  if (!clause) notFound();

  return (
    <div className={staticStyles.pageContainer}>
      <LandingNav theme="light" />
      <main className={staticStyles.mainContent}>
        <article style={{ maxWidth: 760, margin: "0 auto" }}>
          <Link href="/knowledge" className={styles.detailBack}>
            ← Knowledge Base
          </Link>
          <div className={styles.detailHead}>
            <span className={styles.badge}>{FORM_LABEL[clause.cpForm] ?? clause.cpForm}</span>
            {clause.clauseRef && <span className={styles.ref}>{clause.clauseRef}</span>}
          </div>
          <h1 className={styles.detailTitle}>{clause.title}</h1>
          <p className={styles.detailBody}>{clause.body}</p>
          {clause.tags.length > 0 && (
            <div className={styles.detailMeta}>
              {clause.tags.map((t) => (
                <span key={t} className={styles.tag}>
                  {t}
                </span>
              ))}
            </div>
          )}
          <p className={styles.sourceNote}>
            Source: {clause.sourceLabel}. General reference information about a standard charter-party
            form — not legal advice.
          </p>
        </article>
      </main>
      <Footer />
    </div>
  );
}
