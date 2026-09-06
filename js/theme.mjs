import { browser } from './browser.mjs';

/**
 * ThemeManager handles theme state management and switching functionality
 * Implements singleton pattern to ensure single instance across the application
 */
export class ThemeManager {
    static instance;
    static STORAGE_KEY = 'theme';

    constructor() {
      if (ThemeManager.instance) {
        return ThemeManager.instance;
      }
      ThemeManager.instance = this;

      this.currentTheme = null;
      this.darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
      this.initPromise = this.initialize();
    }

    /**
     * Initialize theme manager by loading saved theme from storage
     * Sets up initial theme and event listeners
     */
    async initialize() {
      try {
        // Check if browser API is available
        if (!browser || !browser.storage || !browser.storage.local) {
          console.warn('Browser storage API not available, using default theme');
          this.currentTheme = null;
          this.applyTheme(this.getActiveTheme());
          this.updateUI(this.getActiveTheme());
          this.setupListeners();
          return;
        }

        // Read theme from storage
        const data = await browser.storage.local.get(ThemeManager.STORAGE_KEY);
        this.currentTheme = (data && data[ThemeManager.STORAGE_KEY]) || null;
        
        // Initialize DOM theme
        this.applyTheme(this.getActiveTheme());
        this.updateUI(this.getActiveTheme());
        this.setupListeners();
      } catch (error) {
        console.error('Failed to initialize theme manager:', error);
        // Fallback to default behavior
        this.currentTheme = null;
        this.applyTheme(this.getActiveTheme());
        this.updateUI(this.getActiveTheme());
        this.setupListeners();
      }
    }

    /**
     * Switch GitHub Markdown CSS theme between dark and light versions
     * @param {string} theme - 'dark' or 'light' theme
     */
    switchGitHubMarkdownTheme(theme) {
      const link = document.querySelector('link[href*="github-markdown-dark.css"]') || document.querySelector('link[href*="github-markdown-light.css"]');
      if (!link) return;

      // Replace with appropriate dark/light version of CSS
      const newHref = theme === 'dark' ? '/css/github-markdown-dark.css' : '/css/github-markdown-light.css';

      if (link.href !== newHref) {
        link.href = newHref;
      }
    }

    /**
     * Get the currently active theme, considering user preference and system settings
     * @returns {string} Current active theme ('dark', 'light', or 'auto')
     */
    getActiveTheme() {
      return this.currentTheme ?? (this.darkMedia.matches ? 'dark' : 'light');
    }

    /**
     * Apply the specified theme to the document
     * @param {string} theme - Theme to apply ('dark', 'light', or 'auto')
     */
    applyTheme(theme) {
      const effectiveTheme = theme === 'auto' ?
        (this.darkMedia.matches ? 'dark' : 'light') :
        theme;

      document.documentElement.setAttribute('data-bs-theme', effectiveTheme);
      this.switchGitHubMarkdownTheme(effectiveTheme);
    }

    /**
     * Set the current theme and persist it to storage
     * @param {string} theme - Theme to set ('dark', 'light', or 'auto')
     */
    async setTheme(theme) {
      try {
        // Check if browser API is available
        if (browser && browser.storage && browser.storage.local) {
          await browser.storage.local.set({ [ThemeManager.STORAGE_KEY]: theme });
        }
        this.currentTheme = theme;
        this.applyTheme(theme);
        this.updateUI(theme);
      } catch (error) {
        console.error('Failed to set theme:', error);
        // Still apply the theme locally even if storage fails
        this.currentTheme = theme;
        this.applyTheme(theme);
        this.updateUI(theme);
      }
    }

    /**
     * Update UI elements to reflect the current theme
     * @param {string} theme - Current theme
     * @param {boolean} focus - Whether to focus the theme switcher
     */
    updateUI(theme, focus = false) {
      const themeSwitcher = document.querySelector('#bd-theme');
      if (!themeSwitcher) return;

      document.querySelectorAll('[data-bs-theme-value]').forEach(btn => {
        const isActive = btn.dataset.bsThemeValue === theme;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive);

        if (isActive) {
          const icon = btn.querySelector('svg use')?.getAttribute('href');
          icon && document.querySelector('.theme-icon-active use')?.setAttribute('href', icon);
        }
      });

      themeSwitcher.setAttribute('aria-label', `Toggle theme (${theme})`);
      focus && themeSwitcher.focus();
    }

    /**
     * Set up event listeners for theme changes
     * Listens for system theme changes and user theme switcher clicks
     */
    setupListeners() {
      // System theme change listener
      this.darkMedia.addEventListener('change', () => {
        if (this.currentTheme === 'auto' || this.currentTheme === null) {
          this.applyTheme(this.getActiveTheme());
        }
      });

      // Theme button click listener
      document.body.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-bs-theme-value]');
        if (!btn) return;
        await this.setTheme(btn.dataset.bsThemeValue);
      });
    }
  }
