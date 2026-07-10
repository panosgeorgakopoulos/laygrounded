import Image from "next/image";
import styles from "./Logo.module.css";

interface LogoProps {
  className?: string;
  theme?: "light" | "dark";
  variant?: "navbar" | "default" | "auth";
}

export function Logo({ className = "", theme = "light", variant = "default" }: LogoProps) {
  const containerClass = `${styles.container} ${styles[variant]} ${theme === "dark" ? styles.themeDark : ""} ${className}`;

  // Image is 1440 x 1069 (approx 4:3)
  // We use CSS to drive the exact width/height in the module to avoid inline style clashing
  let width = 140;
  let height = 104;

  if (variant === "navbar") {
    width = 32;
    height = 24;
  } else if (variant === "auth") {
    width = 180;
    height = 133;
  }

  return (
    <div className={containerClass}>
      <Image 
        src="/images/logo_no_background.png" 
        alt="LayGrounded Logo"
        width={width} 
        height={height} 
        className={styles.image} 
        priority
      />
    </div>
  );
}
