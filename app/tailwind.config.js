// Configuration migree telle quelle depuis le bloc <script>tailwind.config = {...}
// qui vivait dans index.html, desormais charge en ligne depuis cdn.tailwindcss.com —
// cassant l'affichage entier de l'application sans connexion internet. Format
// v3 conserve volontairement (Tailwind v4 le supporte encore pour retro-
// compatibilite) plutot que traduit vers la nouvelle syntaxe CSS @theme,
// pour minimiser le risque d'erreur de traduction sur les valeurs.
export default {
  darkMode: 'class',
  content: ['./index.html', './**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        suno: {
          DEFAULT: '#09090b',
          sidebar: '#000000',
          panel: '#121214',
          card: '#18181b',
          hover: '#27272a',
          border: '#27272a',
        }
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      animation: {
        'gradient-x': 'gradient-x 15s ease infinite',
      },
      keyframes: {
        'gradient-x': {
          '0%, 100%': {
            'background-size': '200% 200%',
            'background-position': 'left center'
          },
          '50%': {
            'background-size': '200% 200%',
            'background-position': 'right center'
          },
        },
      }
    }
  }
};
