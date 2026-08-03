import React from "react";
import styles from "./Input.module.css";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, ...props }, ref) => {
    // The label was previously rendered with no `htmlFor` and the input with no
    // `id`, so the two were never associated: a screen reader announced the
    // field as unlabelled, clicking the label did not focus it, and
    // `getByLabel` could not find it. Found while writing the E2E suite, which
    // is the useful accident — an accessibility defect that no unit test would
    // ever have surfaced.
    //
    // `useId` so a caller-supplied id still wins (some forms need a stable one
    // for their own `htmlFor` or scroll-to-error handling).
    const generated = React.useId();
    const inputId = id ?? generated;
    const errorId = `${inputId}-error`;

    return (
      <div className={styles.wrapper}>
        {label && (
          <label className={styles.label} htmlFor={inputId}>
            {label}
          </label>
        )}
        <input
          id={inputId}
          className={`${styles.input} ${error ? styles.error : ""} ${className || ""}`}
          ref={ref}
          // Points assistive technology at the message rather than leaving the
          // field merely red, which conveys nothing without sight.
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          {...props}
        />
        {error && (
          <span id={errorId} className={styles.errorMessage} role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";
