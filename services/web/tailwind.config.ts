import type { Config } from 'tailwindcss';

const v = (name: string) => `var(--${name})`;

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: v('page'),
        surface: v('surface'),
        raised: v('raised'),
        ink: v('ink'),
        ink2: v('ink-2'),
        muted: v('muted'),
        line: v('line'),
        accent: v('accent'),
        'accent-ink': v('accent-ink'),
        'accent-soft': v('accent-soft'),
        good: v('good'),
        warn: v('warn'),
        bad: v('bad'),
      },
      fontFamily: { sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;
