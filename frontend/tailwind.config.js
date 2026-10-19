/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // iOS dark palette: everything reads the CSS variables in index.css (design doc §7.1, §7.2)
        bg: {
          DEFAULT: 'var(--color-bg)',
          surface: 'var(--color-surface)',
          card: 'var(--color-card)',
          elevated: 'var(--color-elevated)',
          // Aliases for classes that compiled to nothing before (bg-bg-primary, bg-bg-secondary)
          primary: 'var(--color-bg)',
          secondary: 'var(--color-surface)',
        },
        // Top-level aliases (bg-card, bg-elevated and bg-surface compiled to nothing before)
        surface: 'var(--color-surface)',
        card: 'var(--color-card)',
        elevated: 'var(--color-elevated)',
        fill: {
          DEFAULT: 'var(--color-fill)',
          secondary: 'var(--color-fill-secondary)',
          tertiary: 'var(--color-fill-tertiary)',
          quaternary: 'var(--color-fill-quaternary)',
        },
        tint: 'var(--color-tint)',
        accent: 'var(--color-accent)',
        'on-accent': 'var(--color-on-accent)',
        'label-tertiary': 'var(--color-text-tertiary)',
        border: {
          DEFAULT: 'var(--color-border)',
          subtle: 'var(--color-border-subtle)',
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
          tertiary: 'var(--color-text-tertiary)',
        },
        // Pokemon brand: the fill accent follows the theme
        brand: {
          red: 'rgb(var(--color-brand-red-rgb) / <alpha-value>)',
          'red-light': 'var(--color-brand-red-light)',
          'red-dark': 'var(--color-brand-red-dark)',
          'red-glow': 'transparent',
          yellow: 'var(--color-yellow)',
        },
        // Status — keeping legacy names for backward compat
        pokemon: {
          red: '#e3000b',
          'red-dark': '#b80009',
          'red-light': '#ff4d4d',
        },
        // Dark theme legacy aliases
        dark: {
          bg: 'var(--color-bg)',
          surface: 'var(--color-surface)',
          card: 'var(--color-card)',
          border: 'var(--color-border)',
          hover: 'var(--color-elevated)',
        },
        // Semantic status colors (iOS dark system colours)
        green: {
          DEFAULT: 'var(--color-green)',
          subtle: '#052e16',
        },
        yellow: {
          DEFAULT: 'var(--color-yellow)',
          subtle: '#1c1807',
        },
        blue: {
          DEFAULT: 'var(--color-blue)',
          subtle: '#0c1a2e',
        },
        red: {
          DEFAULT: 'var(--color-red)',
        },
        orange: {
          DEFAULT: 'var(--color-orange)',
        },
        // Pokemon gold
        gold: '#f5c842',
        'gold-muted': 'rgba(245,200,66,0.15)',
        'gold-border': 'rgba(245,200,66,0.35)',
        // Pokemon energy type colors (the solids of design doc §7.12)
        'type-fire': 'var(--type-fire)',
        'type-water': 'var(--type-water)',
        'type-grass': 'var(--type-grass)',
        'type-lightning': 'var(--type-lightning)',
        'type-psychic': 'var(--type-psychic)',
        'type-fighting': 'var(--type-fighting)',
        'type-darkness': 'var(--type-darkness)',
        'type-metal': 'var(--type-metal)',
        'type-dragon': 'var(--type-dragon)',
        'type-fairy': 'var(--type-fairy)',
        'type-colorless': 'var(--type-colorless)',
        'poke-red': 'var(--poke-red)',
        'poke-yellow': 'var(--poke-yellow)',
        'poke-blue': 'var(--poke-blue)',
      },

      fontFamily: {
        // System fonts only; nothing is downloaded (design doc §7.6)
        sans: ['-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        display: ['ui-rounded', '"SF Pro Rounded"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },

      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.75rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
        '4xl': ['2.25rem', { lineHeight: '2.5rem' }],
        // iOS text styles (design doc §7.6). The display font for the heavy ones comes from index.css.
        'tile-number': ['30px', { lineHeight: '34px', fontWeight: '800' }],
        'large-title': ['34px', { lineHeight: '41px', fontWeight: '800' }],
        'title-1': ['28px', { lineHeight: '34px', fontWeight: '800' }],
        'title-2': ['22px', { lineHeight: '28px', fontWeight: '800' }],
        'title-3': ['20px', { lineHeight: '25px', fontWeight: '800' }],
        headline: ['17px', { lineHeight: '22px', fontWeight: '600' }],
        body: ['17px', { lineHeight: '22px', fontWeight: '400' }],
        callout: ['16px', { lineHeight: '21px', fontWeight: '400' }],
        subheadline: ['15px', { lineHeight: '20px', fontWeight: '400' }],
        footnote: ['13px', { lineHeight: '18px', fontWeight: '400' }],
        'caption-1': ['12px', { lineHeight: '16px', fontWeight: '400' }],
        'caption-2': ['11px', { lineHeight: '13px', fontWeight: '400' }],
      },

      zIndex: {
        navbar: 'var(--z-navbar)',
        tabbar: 'var(--z-tabbar)',
        sheet: 'var(--z-sheet)',
        menu: 'var(--z-menu)',
        scanner: 'var(--z-scanner)',
      },

      transitionTimingFunction: {
        ios: 'var(--ease-ios)',
      },

      borderRadius: {
        sm: '0.375rem',
        DEFAULT: '0.5rem',
        md: '0.5rem',
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
        '3xl': '1.5rem',
        full: '9999px',
      },

      spacing: {
        'safe-b': 'env(safe-area-inset-bottom)',
        'safe-t': 'env(safe-area-inset-top)',
      },

      height: {
        dvh: '100dvh',
      },

      maxHeight: {
        dvh: '100dvh',
        '85dvh': '85dvh',
        '92dvh': '92dvh',
      },

      animation: {
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-up': 'slideUp 0.25s ease-out',
        'slide-down': 'slideDown 0.25s ease-out',
        'pulse-slow': 'pulse 3s infinite',
        'spin-slow': 'spin 8s linear infinite',
      },

      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },

      boxShadow: {
        card: '0 2px 8px rgba(0,0,0,0.4)',
        elevated: '0 4px 16px rgba(0,0,0,0.5)',
        // The glows are gone (design doc §7.5); the names stay so call sites keep compiling
        glow: 'none',
        'glow-lg': 'none',
        'glow-btn': 'none',
      },
    },
  },
  plugins: [],
}
