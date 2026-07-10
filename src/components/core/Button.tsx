import React from "react";
import styles from "./Button.module.css";
import { Loader2 } from "lucide-react";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "default", isLoading, children, disabled, ...props }, ref) => {
    
    const combinedClassName = [
      styles.button,
      styles[variant],
      size !== "default" ? styles[size] : "",
      isLoading ? styles.loading : "",
      className || "",
    ].filter(Boolean).join(" ");

    return (
      <button
        ref={ref}
        className={combinedClassName}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && <Loader2 className={styles.spinner} />}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
