"use client";

import React, { ReactNode } from "react";
import styles from "./Story.module.css";

interface ChapterCardProps {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  align?: "left" | "right" | "center";
}

export function ChapterCard({ title, subtitle, children, align = "center" }: ChapterCardProps) {
  const alignmentClass = align === "left" ? styles.alignLeft : align === "right" ? styles.alignRight : styles.alignCenter;

  return (
    <div className={`${styles.chapterCardWrapper} ${alignmentClass}`}>
      <div className={`${styles.chapterCard} chapter-card`}>
        {subtitle && <div className={styles.cardSubtitle}>{subtitle}</div>}
        <h2 className={styles.cardTitle}>{title}</h2>
        <div className={styles.cardContent}>
          {children}
        </div>
      </div>
    </div>
  );
}
