import type { Config } from "tailwindcss";

// ⚠️ This project ships only Tailwind's pre-defined base utility classes.
// There is NO JIT compiler at build time. That means:
//   • Class names must be string literals in source (`className="p-4"`).
//   • Dynamic class names (`className={`p-${size}`}`) silently drop styles
//     at runtime — Tailwind's content scanner can't see them.
//   • If you need conditional classes, use a literal-class lookup table:
//       const SIZES = { sm: 'p-2', md: 'p-4', lg: 'p-6' } as const;
//       <div className={SIZES[size]} />

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Surface hierarchy — light theme */
        surface: {
          0: "#F0F2F5",
          1: "#F5F7FA",
          2: "#FFFFFF",
          3: "#FFFFFF",
        },
        /* Brand amber (warm gold accent) */
        brand: {
          DEFAULT: "#D49040",
          bright:  "#F0A84E",
          dim:     "rgba(212,144,64,0.10)",
        },
        /* Navy — primary UI color */
        navy: {
          950: "#0F2640",
          900: "#132E4F",
          800: "#1B3A5C",
          700: "#234B72",
          600: "#2B5C88",
          500: "#2563EB",
          400: "#3B82F6",
          300: "#60A5FA",
        },
        /* Override Tailwind amber to match brand */
        amber: {
          50:  "#fff8ed",
          100: "#ffefd0",
          200: "#ffda9a",
          300: "#ffc063",
          400: "#ffa030",
          500: "#f08418",
          600: "#D49040",
          700: "#b06e10",
          800: "#8d5514",
          900: "#744716",
        },
        /* Semantic shortcuts */
        hotel: {
          green:          "#22c55e",
          "green-dark":   "#16a34a",
          red:            "#ef4444",
          amber:          "#D49040",
          "amber-bright": "#F0A84E",
          gold:           "#fbbf24",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body:    ["var(--font-body)",    "sans-serif"],
        mono:    ["var(--font-mono)",    "monospace"],
      },
      borderRadius: {
        /* Spec: design-principles §radii */
        btn: "10px",    /* button.md §Quick Ref */
        card:"12px",    /* card.md §Quick Ref */
        lg:  "16px",
        xl:  "20px",
        "2xl":"24px",
        "3xl":"28px",
      },
      boxShadow: {
        /* Light theme card shadows */
        "card-1": "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
        "card-2": "0 4px 6px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04)",
        "card-3": "0 10px 15px rgba(0,0,0,0.06), 0 4px 6px rgba(0,0,0,0.04)",
        "card-4": "0 20px 25px rgba(0,0,0,0.08), 0 10px 10px rgba(0,0,0,0.04)",
        "amber":       "0 0 24px rgba(212,144,64,0.15), 0 0 64px rgba(212,144,64,0.05)",
        "amber-strong":"0 0 48px rgba(212,144,64,0.25), 0 0 100px rgba(212,144,64,0.10)",
        "nav":         "0 -1px 0 rgba(0,0,0,0.05), 0 -4px 16px rgba(0,0,0,0.04)",
      },
      animation: {
        "fade-in":   "fade-in 200ms cubic-bezier(0.05,0.7,0.1,1) both",
        "slide-up":  "slide-up 300ms cubic-bezier(0.05,0.7,0.1,1) both",
        "count-up":  "count-up 450ms cubic-bezier(0.05,0.7,0.1,1) both",
        "glow-pulse":"glow-pulse 2.8s ease-in-out infinite",
        "spin":      "spin 0.75s linear infinite",
      },
      keyframes: {
        "fade-in":   { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up":  { from: { opacity:"0", transform:"translateY(28px)" }, to: { opacity:"1", transform:"translateY(0)" } },
        "count-up":  { from: { opacity:"0", transform:"translateY(20px) scale(0.9)" }, to: { opacity:"1", transform:"translateY(0) scale(1)" } },
        "glow-pulse":{ "0%,100%": { boxShadow:"0 0 24px rgba(212,144,64,0.30),0 0 64px rgba(212,144,64,0.10)" }, "50%": { boxShadow:"0 0 48px rgba(212,144,64,0.50),0 0 100px rgba(212,144,64,0.20)" } },
        "spin":      { to: { transform:"rotate(360deg)" } },
      },
    },
  },
  plugins: [],
};

export default config;
