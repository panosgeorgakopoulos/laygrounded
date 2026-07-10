import React from "react";
import styles from "./Footer.module.css";
import Link from "next/link";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        <div className={styles.brand}>
          <span className={styles.brandName}>LayGrounded</span>
          <p className={styles.brandDesc}>
            The intelligent engine for shipping demurrage claims.
          </p>
        </div>
        
        <div className={styles.links}>
          <div className={styles.linkGroup}>
            <h4>Product</h4>
            <Link href="/features">Features</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/sign-in">Sign In</Link>
          </div>
          <div className={styles.linkGroup}>
            <h4>Legal</h4>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
          </div>
          <div className={styles.linkGroup}>
            <h4>Company</h4>
            <Link href="/contact">Contact Us</Link>
            <Link href="/about">About</Link>
          </div>
        </div>
      </div>
      <div className={styles.bottomBar}>
        <p>&copy; {new Date().getFullYear()} LayGrounded. All rights reserved.</p>
      </div>
    </footer>
  );
}
